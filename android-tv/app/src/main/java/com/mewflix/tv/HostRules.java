package com.mewflix.tv;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Règles d'en-têtes par hébergeur vidéo : port fidèle de
 * desktop/src/lib/mediaProxyHeaders.js (lui-même porté de l'appli mobile et du
 * relais Python). Les trois chemins doivent présenter le même client à l'amont :
 * toute modification se fait d'abord dans le module de bureau, puis ici.
 */
final class HostRules {
    private static final String SIGNED_USER_AGENT =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    + "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
    private static final String SEC_CH_UA = "\"Chromium\";v=\"140\", \"Not=A?Brand\";v=\"24\", \"Google Chrome\";v=\"140\"";
    private static final String SEC_CH_UA_MOBILE = "?0";
    private static final String SEC_CH_UA_PLATFORM = "\"Windows\"";
    private static final String ACCEPT_LANGUAGE = "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7";
    private static final String MEDIA_ACCEPT_ENCODING = "identity, gzip;q=0, deflate;q=0, br;q=0, zstd;q=0";
    private static final String EXTRACTION_USER_AGENT = "Mozilla/5.0 Chrome/143.0.0.0";
    private static final Pattern MEDIA_PATH = Pattern.compile("\\.(?:m3u8|mpd|mp4|m4v|m4s|ts|aac|m4a|vtt|srt|key)$", Pattern.CASE_INSENSITIVE);
    private static final Pattern UQLOAD = Pattern.compile("(?:^|\\.)(uqload\\.[a-z]{2,24})$");
    private static final String[] CLIENT_HINTS = {"Sec-Ch-Ua", "Sec-Ch-Ua-Mobile", "Sec-Ch-Ua-Platform"};

    /** Suffixes d'hôtes (un point initial = sous-domaines seulement) puis origine à présenter. */
    private static final String[][] PROVIDER_HOSTS = {
            {"lulustream.com", "luluvdo.com", "luluvdoo.com", "luluvid.com", "lulu.st",
                    "streamhihi.com", "cdn1.site", "d00ds.site", "732eg54de642sa.sbs", ".tnmr.org"},
            {"veev.to", "veev.pro", "poophq.com", "doods.to", ".veevcdn.co"},
            {"vidara.to", "vidara.so", ".s1q2105.com", ".97bf1.com"},
    };
    private static final String[] PROVIDER_ORIGINS = {"https://lulustream.com", "https://veev.to", "https://vidara.to"};

    private HostRules() {
    }

    private static final Pattern AUTHORITY = Pattern.compile("^[a-z][a-z0-9+.-]*://([^/?#]*)", Pattern.CASE_INSENSITIVE);

    /** Hôte d'une URL absolue, en minuscules, sans point final ; null si illisible (comme hostnameOf côté bureau). */
    static String hostOf(String url) {
        Matcher match = AUTHORITY.matcher(url == null ? "" : url.trim());
        if (!match.find()) return null;
        String authority = match.group(1);
        int credentialsEnd = authority.lastIndexOf('@');
        String hostPort = credentialsEnd >= 0 ? authority.substring(credentialsEnd + 1) : authority;
        if (hostPort.startsWith("[")) {
            int end = hostPort.indexOf(']');
            return end < 0 ? null : hostPort.substring(0, end + 1).toLowerCase(Locale.ROOT);
        }
        int portStart = hostPort.indexOf(':');
        String host = portStart >= 0 ? hostPort.substring(0, portStart) : hostPort;
        if (host.isEmpty()) return null;
        return host.toLowerCase(Locale.ROOT).replaceAll("\\.+$", "");
    }

    private static boolean matchesHost(String hostname, String suffix) {
        if (suffix.startsWith(".")) return hostname.endsWith(suffix);
        return hostname.equals(suffix) || hostname.endsWith("." + suffix);
    }

    private static String providerOriginFor(String hostname) {
        for (int i = 0; i < PROVIDER_HOSTS.length; i++) {
            for (String suffix : PROVIDER_HOSTS[i]) {
                if (matchesHost(hostname, suffix)) return PROVIDER_ORIGINS[i];
            }
        }
        return null;
    }

    private static boolean isFsvid(String hostname) {
        return matchesHost(hostname, "fsvid.lol");
    }

    private static boolean isVidzy(String hostname) {
        return matchesHost(hostname, "vidzy.org") || matchesHost(hostname, "vidzy.cc");
    }

    /** Vrai si l'URL vise un hébergeur couvert par les règles. */
    static boolean isProviderUrl(String url) {
        String hostname = hostOf(url);
        if (hostname == null) return false;
        return isFsvid(hostname) || isVidzy(hostname) || UQLOAD.matcher(hostname).find() || providerOriginFor(hostname) != null;
    }

    private static void remove(Map<String, String> headers, String name) {
        Iterator<String> names = headers.keySet().iterator();
        while (names.hasNext()) {
            if (names.next().equalsIgnoreCase(name)) names.remove();
        }
    }

    private static String get(Map<String, String> headers, String name) {
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            if (entry.getKey().equalsIgnoreCase(name)) return entry.getValue();
        }
        return null;
    }

    private static void set(Map<String, String> headers, String name, String value) {
        remove(headers, name);
        headers.put(name, value);
    }

    /** Copie des en-têtes avec les règles de l'hébergeur appliquées (entrée intacte). */
    static Map<String, String> apply(String url, Map<String, String> input) {
        Map<String, String> headers = new LinkedHashMap<>(input);
        String hostname = hostOf(url);
        if (hostname == null) return headers;

        boolean fsvid = isFsvid(hostname);
        boolean vidzy = isVidzy(hostname);
        Matcher uqload = UQLOAD.matcher(hostname);
        String uqloadRoot = uqload.find() ? uqload.group(1) : null;
        String providerOrigin = providerOriginFor(hostname);
        if (!fsvid && !vidzy && uqloadRoot == null && providerOrigin == null) return headers;

        String origin;
        if (fsvid) origin = hostname.equals("fsvid.lol") ? "https://fs13.lol" : "https://fsvid.lol";
        else if (vidzy) origin = "https://vidzy.org";
        else if (uqloadRoot != null) origin = "https://" + uqloadRoot;
        else origin = providerOrigin;
        set(headers, "Origin", origin);
        set(headers, "Referer", origin + "/");

        if (providerOrigin != null && !fsvid && !vidzy && uqloadRoot == null) {
            set(headers, "User-Agent", EXTRACTION_USER_AGENT);
            set(headers, "Accept-Language", ACCEPT_LANGUAGE);
            for (String hint : CLIENT_HINTS) {
                String value = get(headers, hint);
                if (value != null && !value.isEmpty()) set(headers, hint, value);
                else remove(headers, hint);
            }
        } else {
            String path = url.split("[?#]", 2)[0];
            if (MEDIA_PATH.matcher(path).find()) set(headers, "Accept-Encoding", MEDIA_ACCEPT_ENCODING);
            else remove(headers, "Accept-Encoding");
            set(headers, "Accept-Language", ACCEPT_LANGUAGE);
            set(headers, "Sec-Ch-Ua", SEC_CH_UA);
            set(headers, "Sec-Ch-Ua-Mobile", SEC_CH_UA_MOBILE);
            set(headers, "Sec-Ch-Ua-Platform", SEC_CH_UA_PLATFORM);
            set(headers, "User-Agent", SIGNED_USER_AGENT);
        }
        set(headers, "Sec-Fetch-Site", "cross-site");
        set(headers, "Sec-Fetch-Mode", "cors");
        set(headers, "Sec-Fetch-Dest", "empty");
        return headers;
    }
}
