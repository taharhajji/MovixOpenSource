package com.mewflix.tv;

import android.webkit.CookieManager;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import java.util.zip.GZIPInputStream;
import java.util.zip.InflaterInputStream;

/**
 * Requête HTTP native, hors des règles du navigateur (pas de CORS, en-têtes
 * libres). Les redirections sont suivies à la main pour ré-appliquer les règles
 * de l'hébergeur à chaque saut — même logique que desktop/src/lib/gmFetch.js.
 */
final class NativeHttp {
    private static final int MAX_REDIRECTS = 5;

    /** Réponse ouverte : le corps reste à lire, puis {@link #close()}. */
    static final class Response {
        final int status;
        final String reason;
        final Map<String, String> headers;
        final InputStream body;
        final String finalUrl;
        private final HttpURLConnection connection;

        Response(int status, String reason, Map<String, String> headers, InputStream body, String finalUrl, HttpURLConnection connection) {
            this.status = status;
            this.reason = reason;
            this.headers = headers;
            this.body = body;
            this.finalUrl = finalUrl;
            this.connection = connection;
        }

        void close() {
            try {
                if (body != null) body.close();
            } catch (IOException ignored) {
                // flux déjà fermé
            }
            connection.disconnect();
        }
    }

    private NativeHttp() {
    }

    private static boolean isRedirect(int status) {
        return status == 301 || status == 302 || status == 303 || status == 307 || status == 308;
    }

    /** Le décodage brotli/zstd n'existe pas ici : on ne l'annonce pas au serveur. */
    private static void dropUnsupportedEncodings(Map<String, String> headers) {
        String name = null;
        for (String key : headers.keySet()) {
            if (key.equalsIgnoreCase("Accept-Encoding")) name = key;
        }
        if (name == null) return;
        String value = headers.get(name).toLowerCase(Locale.ROOT);
        boolean refusesAll = value.contains("br;q=0") && value.contains("zstd;q=0");
        if (!refusesAll && (value.contains("br") || value.contains("zstd"))) headers.remove(name);
    }

    private static boolean has(Map<String, String> headers, String name) {
        for (String key : headers.keySet()) {
            if (key.equalsIgnoreCase(name)) return true;
        }
        return false;
    }

    private static Map<String, String> flatten(HttpURLConnection connection) {
        Map<String, String> out = new LinkedHashMap<>();
        for (Map.Entry<String, List<String>> entry : connection.getHeaderFields().entrySet()) {
            if (entry.getKey() == null || entry.getValue() == null) continue;
            String separator = entry.getKey().equalsIgnoreCase("Set-Cookie") ? "\n" : ", ";
            out.put(entry.getKey(), String.join(separator, entry.getValue()));
        }
        return out;
    }

    /**
     * @param cookies    joindre les cookies du WebView et mémoriser ceux reçus
     * @param current    connexion en cours, pour pouvoir l'interrompre d'un autre fil
     */
    static Response open(String url, String method, Map<String, String> baseHeaders, byte[] body,
                         int timeoutMs, boolean cookies, AtomicReference<HttpURLConnection> current) throws IOException {
        String currentUrl = url;
        String currentMethod = method;
        byte[] currentBody = body;
        for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
            if (!currentUrl.startsWith("https://") && !currentUrl.startsWith("http://")) throw new IOException("URL non supportée");
            Map<String, String> headers = HostRules.apply(currentUrl, baseHeaders);
            dropUnsupportedEncodings(headers);
            HttpURLConnection connection = (HttpURLConnection) new URL(currentUrl).openConnection();
            if (current != null) current.set(connection);
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(timeoutMs);
            connection.setReadTimeout(timeoutMs);
            connection.setRequestMethod(currentMethod);
            for (Map.Entry<String, String> header : headers.entrySet()) {
                if (header.getValue() == null || header.getValue().isEmpty()) continue;
                try {
                    connection.setRequestProperty(header.getKey(), header.getValue());
                } catch (RuntimeException refused) {
                    // en-tête refusé par la pile réseau : ignoré, comme le ferait le navigateur
                }
            }
            if (cookies && !has(headers, "Cookie")) {
                String stored = CookieManager.getInstance().getCookie(currentUrl);
                if (stored != null && !stored.isEmpty()) connection.setRequestProperty("Cookie", stored);
            }
            boolean sendsBody = currentBody != null && !"GET".equals(currentMethod) && !"HEAD".equals(currentMethod);
            if (sendsBody) {
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(currentBody.length);
                try (OutputStream out = connection.getOutputStream()) {
                    out.write(currentBody);
                }
            }

            int status = connection.getResponseCode();
            if (cookies) {
                List<String> received = connection.getHeaderFields().get("Set-Cookie");
                if (received != null) {
                    for (String cookie : received) CookieManager.getInstance().setCookie(currentUrl, cookie);
                }
            }
            String location = connection.getHeaderField("Location");
            if (isRedirect(status) && location != null) {
                connection.disconnect();
                if (hop == MAX_REDIRECTS) throw new IOException("Trop de redirections");
                currentUrl = new URL(new URL(currentUrl), location).toString();
                if (status != 307 && status != 308) {
                    currentMethod = "GET";
                    currentBody = null;
                }
                continue;
            }

            Map<String, String> responseHeaders = flatten(connection);
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String encoding = connection.getContentEncoding();
            if (stream != null && encoding != null) {
                // Compression demandée explicitement par l'appelant : la pile ne la retire pas d'elle-même.
                String lowered = encoding.toLowerCase(Locale.ROOT);
                if (lowered.contains("gzip")) stream = new GZIPInputStream(stream);
                else if (lowered.contains("deflate")) stream = new InflaterInputStream(stream);
                if (lowered.contains("gzip") || lowered.contains("deflate")) {
                    responseHeaders.keySet().removeIf(key -> key.equalsIgnoreCase("Content-Encoding") || key.equalsIgnoreCase("Content-Length"));
                }
            }
            String reason = connection.getResponseMessage();
            return new Response(status, reason == null ? "" : reason, responseHeaders, stream, currentUrl, connection);
        }
        throw new IOException("Trop de redirections");
    }
}
