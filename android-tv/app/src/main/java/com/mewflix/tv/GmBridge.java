package com.mewflix.tv;

import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;
import android.webkit.WebView;

import androidx.annotation.NonNull;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Pont « extension » : exécute nativement les GM_xmlhttpRequest du userscript
 * (pas de CORS, en-têtes libres), comme desktop/src/lib/gmFetch.js. La page
 * parle à l'objet {@code MewflixNative}, injecté uniquement dans le cadre
 * principal des pages du site ; messages JSON :
 * <pre>
 *   page → appli : { "reqId": "r1", "type": "fetch", "payload": { id, url, method, headers, body, bodyEncoding, responseType, timeout, anonymous } }
 *                  { "reqId": "r2", "type": "abort", "payload": "gm_3_…" }
 *   appli → page : { "reqId": "r1", "result": { id, success, status, statusText, headers, body, bodyEncoding, finalUrl } }
 *                  { "reqId": "r1", "result": { id, success: false, error, timedOut } }
 * </pre>
 */
final class GmBridge implements WebViewCompat.WebMessageListener {
    static final String OBJECT_NAME = "MewflixNative";
    private static final String TAG = "MewflixTV";
    private static final int DEFAULT_TIMEOUT_MS = 30000;
    private static final int MAX_TIMEOUT_MS = 120000;
    private static final int MAX_BODY_BYTES = 64 * 1024 * 1024;
    private static final int WORKERS = 6;
    private static final Pattern CHARSET = Pattern.compile("charset=[\"']?([A-Za-z0-9_-]+)");

    private final ExecutorService workers = Executors.newFixedThreadPool(WORKERS);
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<String, AtomicReference<HttpURLConnection>> inflight = new ConcurrentHashMap<>();

    @Override
    public void onPostMessage(@NonNull WebView view, @NonNull WebMessageCompat message, @NonNull Uri sourceOrigin,
                              boolean isMainFrame, @NonNull JavaScriptReplyProxy replyProxy) {
        if (!isMainFrame) return;
        final String reqId;
        final String type;
        final JSONObject envelope;
        try {
            envelope = new JSONObject(String.valueOf(message.getData()));
            reqId = envelope.getString("reqId");
            type = envelope.getString("type");
        } catch (JSONException err) {
            return;
        }
        if ("abort".equals(type)) {
            AtomicReference<HttpURLConnection> entry = inflight.remove(envelope.optString("payload"));
            HttpURLConnection connection = entry == null ? null : entry.get();
            if (connection != null) workers.execute(connection::disconnect);
            reply(replyProxy, reqId, connection != null);
        } else if ("fetch".equals(type)) {
            final JSONObject payload = envelope.optJSONObject("payload");
            if (payload == null) return;
            workers.execute(() -> reply(replyProxy, reqId, fetch(payload)));
        }
    }

    private void reply(JavaScriptReplyProxy proxy, String reqId, Object result) {
        final String json;
        try {
            json = new JSONObject().put("reqId", reqId).put("result", result).toString();
        } catch (JSONException err) {
            return;
        }
        main.post(() -> {
            try {
                proxy.postMessage(json);
            } catch (RuntimeException gone) {
                // page fermée entre-temps
            }
        });
    }

    private static JSONObject failure(String id, String error, boolean timedOut) {
        try {
            return new JSONObject().put("id", id).put("success", false).put("error", error).put("timedOut", timedOut);
        } catch (JSONException err) {
            return new JSONObject();
        }
    }

    private JSONObject fetch(JSONObject message) {
        final String id = message.optString("id");
        String url = message.optString("url");
        if (!url.startsWith("https://") && !url.startsWith("http://")) return failure(id, "URL non supportée", false);

        final AtomicReference<HttpURLConnection> current = new AtomicReference<>();
        if (!id.isEmpty()) inflight.put(id, current);
        int requested = message.optInt("timeout", DEFAULT_TIMEOUT_MS);
        int timeoutMs = requested > 0 ? Math.min(requested, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
        final AtomicBoolean timedOut = new AtomicBoolean(false);
        Runnable watchdog = () -> {
            timedOut.set(true);
            HttpURLConnection connection = current.get();
            if (connection != null) workers.execute(connection::disconnect);
        };
        main.postDelayed(watchdog, timeoutMs);

        NativeHttp.Response response = null;
        try {
            Map<String, String> headers = new LinkedHashMap<>();
            JSONObject given = message.optJSONObject("headers");
            if (given != null) {
                for (Iterator<String> names = given.keys(); names.hasNext(); ) {
                    String name = names.next();
                    headers.put(name, given.optString(name));
                }
            }
            byte[] body = null;
            if (!message.isNull("body")) {
                String raw = message.optString("body");
                body = "base64".equals(message.optString("bodyEncoding"))
                        ? Base64.decode(raw, Base64.DEFAULT) : raw.getBytes(StandardCharsets.UTF_8);
            }
            String method = message.optString("method", "GET").toUpperCase(java.util.Locale.ROOT);
            response = NativeHttp.open(url, method, headers, body, timeoutMs, !message.optBoolean("anonymous", false), current);
            byte[] bytes = readAll(response.body);

            String responseType = message.optString("responseType");
            boolean binary = "arraybuffer".equals(responseType) || "blob".equals(responseType);
            JSONObject flat = new JSONObject();
            String contentType = "";
            for (Map.Entry<String, String> header : response.headers.entrySet()) {
                flat.put(header.getKey(), header.getValue());
                if (header.getKey().equalsIgnoreCase("Content-Type")) contentType = header.getValue();
            }
            return new JSONObject()
                    .put("id", id)
                    .put("success", true)
                    .put("status", response.status)
                    .put("statusText", response.reason)
                    .put("headers", flat)
                    .put("body", binary ? Base64.encodeToString(bytes, Base64.NO_WRAP) : new String(bytes, charsetOf(contentType)))
                    .put("bodyEncoding", binary ? "base64" : "text")
                    .put("finalUrl", response.finalUrl);
        } catch (IOException | JSONException | RuntimeException err) {
            boolean aborted = !id.isEmpty() && !inflight.containsKey(id);
            if (timedOut.get()) return failure(id, "Délai dépassé", true);
            if (BuildConfig.DEBUG) Log.d(TAG, "requête native échouée : " + HostRules.hostOf(url) + " — " + err);
            return failure(id, aborted ? "Requête annulée" : String.valueOf(err.getMessage() == null ? "Requête échouée" : err.getMessage()), false);
        } finally {
            main.removeCallbacks(watchdog);
            if (!id.isEmpty()) inflight.remove(id);
            if (response != null) response.close();
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        if (in == null) return new byte[0];
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[16384];
        int read;
        while ((read = in.read(buffer)) > 0) {
            if (out.size() + read > MAX_BODY_BYTES) throw new IOException("Réponse trop volumineuse");
            out.write(buffer, 0, read);
        }
        return out.toByteArray();
    }

    private static Charset charsetOf(String contentType) {
        Matcher match = CHARSET.matcher(contentType == null ? "" : contentType);
        if (match.find()) {
            try {
                return Charset.forName(match.group(1));
            } catch (RuntimeException unknown) {
                // jeu de caractères inconnu : UTF-8 ci-dessous
            }
        }
        return StandardCharsets.UTF_8;
    }

    void shutdown() {
        workers.shutdownNow();
    }
}
