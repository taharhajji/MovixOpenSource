package com.mewflix.tv;

import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Relais des ressources tierces demandées par la page du site (flux vidéo,
 * sous-titres…). Sur le bureau, Electron retouche ces requêtes au vol
 * (installWebRequestHooks dans desktop/src/main.js) : règles d'en-têtes de
 * l'hébergeur à l'aller, CORS ouvert au retour. Un WebView ne sait pas modifier
 * une requête : elle est donc refaite ici et sa réponse rendue à la page.
 */
final class MediaRelay {
    private static final int TIMEOUT_MS = 30000;
    private static final int NO_CONTENT = 204;
    /** Services qui gèrent déjà le CORS eux-mêmes ou exigent le vrai navigateur (vérification Cloudflare). */
    private static final String[] DIRECT_HOSTS = {
            "themoviedb.org", "tmdb.org", "googleapis.com", "gstatic.com", "google.com", "youtube.com",
            "ytimg.com", "cloudflare.com", "cloudflareinsights.com", "jsdelivr.net", "unpkg.com",
    };

    private MediaRelay() {
    }

    private static String header(Map<String, String> headers, String name) {
        if (headers == null) return null;
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            if (entry.getKey().equalsIgnoreCase(name)) return entry.getValue();
        }
        return null;
    }

    private static boolean isDirect(String host) {
        for (String suffix : DIRECT_HOSTS) {
            if (host.equals(suffix) || host.endsWith("." + suffix)) return true;
        }
        return false;
    }

    private static void openCors(Map<String, String> headers, String origin) {
        headers.keySet().removeIf(name -> name.toLowerCase(Locale.ROOT).startsWith("access-control-"));
        headers.put("Access-Control-Allow-Origin", origin == null ? "*" : origin);
        if (origin != null) {
            headers.put("Access-Control-Allow-Credentials", "true");
            headers.put("Vary", "Origin");
        }
        headers.put("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD, PUT, DELETE, PATCH");
        headers.put("Access-Control-Expose-Headers", "*");
    }

    /** @return la réponse à rendre à la page, ou null pour laisser le WebView faire la requête lui-même */
    static WebResourceResponse intercept(WebResourceRequest request) {
        String url = request.getUrl().toString();
        String host = HostRules.hostOf(url);
        if (host == null || !"https".equals(request.getUrl().getScheme()) || isDirect(host)) return null;
        Map<String, String> given = request.getRequestHeaders();
        String origin = header(given, "Origin");
        boolean fromSite = origin != null && MainActivity.isSiteHost(HostRules.hostOf(origin));
        if (!fromSite && !HostRules.isProviderUrl(url)) return null;

        String method = request.getMethod();
        if ("OPTIONS".equals(method)) {
            if (!fromSite) return null;
            // Pré-vérification CORS : répondue ici, la vraie requête suivra par le relais.
            Map<String, String> headers = new LinkedHashMap<>();
            openCors(headers, origin);
            String asked = header(given, "Access-Control-Request-Headers");
            headers.put("Access-Control-Allow-Headers", asked == null ? "*" : asked);
            headers.put("Access-Control-Max-Age", "600");
            return new WebResourceResponse("text/plain", "utf-8", NO_CONTENT, "No Content", headers, new ByteArrayInputStream(new byte[0]));
        }
        if (!"GET".equals(method) && !"HEAD".equals(method)) return null;

        try {
            final NativeHttp.Response response = NativeHttp.open(url, method,
                    given == null ? new LinkedHashMap<String, String>() : new LinkedHashMap<>(given), null, TIMEOUT_MS, false, null);
            // Un WebView refuse qu'on lui rende une redirection ou un statut hors plage.
            if (response.status < 200 || (response.status >= 300 && response.status < 400)) {
                response.close();
                return null;
            }
            Map<String, String> headers = new LinkedHashMap<>(response.headers);
            if (fromSite) openCors(headers, origin);
            String contentType = header(headers, "Content-Type");
            String mime = "application/octet-stream";
            String charset = null;
            if (contentType != null && !contentType.isEmpty()) {
                String[] parts = contentType.split(";");
                mime = parts[0].trim();
                for (String part : parts) {
                    String trimmed = part.trim();
                    if (trimmed.toLowerCase(Locale.ROOT).startsWith("charset=")) charset = trimmed.substring("charset=".length()).replace("\"", "");
                }
            }
            InputStream body = response.body == null ? new ByteArrayInputStream(new byte[0]) : new ClosingStream(response);
            String reason = response.reason.isEmpty() ? "OK" : response.reason;
            return new WebResourceResponse(mime, charset, response.status, reason, headers, body);
        } catch (IOException | RuntimeException err) {
            return null;
        }
    }

    /** Libère la connexion quand le WebView a fini de lire le corps. */
    private static final class ClosingStream extends FilterInputStream {
        private final NativeHttp.Response response;

        ClosingStream(NativeHttp.Response response) {
            super(response.body);
            this.response = response;
        }

        @Override
        public void close() throws IOException {
            response.close();
        }
    }
}
