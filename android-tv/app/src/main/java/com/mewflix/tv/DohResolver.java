package com.mewflix.tv;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URL;
import java.net.URLEncoder;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * Résolution des noms par DNS chiffré (DNS-over-HTTPS), sans passer par le DNS
 * de la box : les fournisseurs d'accès y bloquent le site (« domaine
 * inexistant »), ce qui donnait « Connexion impossible » sur les télés. Même
 * rôle que le « DNS sécurisé » de l'appli de bureau (applySecureDns dans
 * desktop/src/main.js) et que le DNS 1.1.1.1 de l'appli mobile.
 *
 * Les services sont joints par leur adresse IP : aucun nom à résoudre pour y arriver.
 */
final class DohResolver {
    /** Cloudflare, Google, Quad9 : API JSON, certificat valable pour l'adresse IP. */
    private static final String[] ENDPOINTS = {
            "https://1.1.1.1/dns-query?type=A&name=",
            "https://8.8.8.8/resolve?type=A&name=",
            "https://9.9.9.9:5053/dns-query?type=A&name=",
    };
    private static final int TIMEOUT_MS = 4000;
    private static final int MAX_RESPONSE_BYTES = 64 * 1024;
    private static final int DNS_TYPE_A = 1;
    private static final long MIN_TTL_MS = 60_000;
    private static final long MAX_TTL_MS = 3_600_000;
    private static final int MAX_CACHE_ENTRIES = 500;
    private static final Pattern IPV4 = Pattern.compile("^\\d{1,3}(\\.\\d{1,3}){3}$");

    private static final class Entry {
        final InetAddress[] addresses;
        final long expiresAt;

        Entry(InetAddress[] addresses, long expiresAt) {
            this.addresses = addresses;
            this.expiresAt = expiresAt;
        }
    }

    /** Réponse d'un service : adresses IPv4 et durée de validité annoncée. */
    static final class Answer {
        final List<String> addresses = new ArrayList<>();
        long ttlSeconds = Long.MAX_VALUE;
    }

    private static final Map<String, Entry> CACHE = new ConcurrentHashMap<>();

    private DohResolver() {
    }

    static boolean isIpLiteral(String host) {
        return host != null && (IPV4.matcher(host).matches() || host.indexOf(':') >= 0);
    }

    /** Extrait les enregistrements A d'une réponse JSON (format commun à Cloudflare, Google et Quad9). */
    static Answer parse(String json) throws JSONException {
        Answer out = new Answer();
        JSONArray answers = new JSONObject(json).optJSONArray("Answer");
        if (answers == null) return out;
        for (int i = 0; i < answers.length(); i++) {
            JSONObject record = answers.optJSONObject(i);
            if (record == null || record.optInt("type") != DNS_TYPE_A) continue;
            String data = record.optString("data");
            if (!IPV4.matcher(data).matches()) continue;
            out.addresses.add(data);
            out.ttlSeconds = Math.min(out.ttlSeconds, record.optLong("TTL", 300));
        }
        return out;
    }

    private static byte[] ipv4Bytes(String address) throws UnknownHostException {
        String[] parts = address.split("\\.");
        byte[] bytes = new byte[4];
        for (int i = 0; i < 4; i++) {
            int value = Integer.parseInt(parts[i]);
            if (value < 0 || value > 255) throw new UnknownHostException(address);
            bytes[i] = (byte) value;
        }
        return bytes;
    }

    private static Answer query(String endpoint, String host) throws IOException, JSONException {
        HttpURLConnection connection = (HttpURLConnection) new URL(endpoint + URLEncoder.encode(host, "UTF-8")).openConnection();
        try {
            connection.setConnectTimeout(TIMEOUT_MS);
            connection.setReadTimeout(TIMEOUT_MS);
            connection.setRequestProperty("Accept", "application/dns-json");
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) throw new IOException("HTTP " + connection.getResponseCode());
            ByteArrayOutputStream body = new ByteArrayOutputStream();
            try (InputStream in = connection.getInputStream()) {
                byte[] buffer = new byte[4096];
                int read;
                while ((read = in.read(buffer)) > 0 && body.size() < MAX_RESPONSE_BYTES) body.write(buffer, 0, read);
            }
            return parse(new String(body.toByteArray(), StandardCharsets.UTF_8));
        } finally {
            connection.disconnect();
        }
    }

    /**
     * Adresses d'un hôte : cache, puis DNS chiffré (trois services essayés), et
     * en dernier recours le DNS du système (réseau qui filtre le DNS chiffré).
     */
    static InetAddress[] resolve(String rawHost) throws UnknownHostException {
        String host = String.valueOf(rawHost).toLowerCase(Locale.ROOT);
        if (isIpLiteral(host) || host.equals("localhost")) return InetAddress.getAllByName(host);

        long now = System.currentTimeMillis();
        Entry cached = CACHE.get(host);
        if (cached != null && cached.expiresAt > now) return cached.addresses;

        for (String endpoint : ENDPOINTS) {
            try {
                Answer answer = query(endpoint, host);
                if (answer.addresses.isEmpty()) continue;
                InetAddress[] addresses = new InetAddress[answer.addresses.size()];
                for (int i = 0; i < addresses.length; i++) {
                    addresses[i] = InetAddress.getByAddress(host, ipv4Bytes(answer.addresses.get(i)));
                }
                long ttl = Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, answer.ttlSeconds * 1000));
                if (CACHE.size() >= MAX_CACHE_ENTRIES) CACHE.clear();
                CACHE.put(host, new Entry(addresses, now + ttl));
                return addresses;
            } catch (IOException | JSONException | RuntimeException err) {
                // service injoignable ou réponse illisible : on passe au suivant
            }
        }
        return InetAddress.getAllByName(host);
    }
}
