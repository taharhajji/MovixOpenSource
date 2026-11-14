package com.mewflix.tv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Les règles doivent donner les mêmes en-têtes que desktop/src/lib/mediaProxyHeaders.js
 * (valeurs attendues reprises de ce module).
 */
public class HostRulesTest {
    private static Map<String, String> headers(String... pairs) {
        Map<String, String> out = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) out.put(pairs[i], pairs[i + 1]);
        return out;
    }

    @Test
    public void hostOfLowercasesAndStripsPortCredentialsAndTrailingDot() {
        assertEquals("cdn.vidzy.org", HostRules.hostOf("https://CDN.Vidzy.org:8443/a/b.m3u8?x=1"));
        assertEquals("veev.to", HostRules.hostOf("https://user:pass@veev.to./e/abc"));
        assertEquals("[::1]", HostRules.hostOf("http://[::1]:8080/x"));
        assertNull(HostRules.hostOf("pas une url"));
        assertNull(HostRules.hostOf(null));
        assertNull(HostRules.hostOf("https:///chemin"));
    }

    @Test
    public void isProviderUrlMatchesExactHostsAndSubdomainsOnly() {
        assertTrue(HostRules.isProviderUrl("https://fsvid.lol/embed/1"));
        assertTrue(HostRules.isProviderUrl("https://s3.vidzy.cc/hls/master.m3u8"));
        assertTrue(HostRules.isProviderUrl("https://uqload.cx/embed-x.html"));
        assertTrue(HostRules.isProviderUrl("https://edge1.veevcdn.co/v.mp4"));
        assertTrue(HostRules.isProviderUrl("https://lulustream.com/e/x"));
        assertFalse("suffixe à point : sous-domaines seulement", HostRules.isProviderUrl("https://veevcdn.co/v.mp4"));
        assertFalse("pas de sous-chaîne", HostRules.isProviderUrl("https://notvidzy.org/x"));
        assertFalse(HostRules.isProviderUrl("https://movix.luxe/watch/movie/1"));
    }

    @Test
    public void unknownHostKeepsHeadersUntouched() {
        Map<String, String> input = headers("Origin", "https://movix.luxe", "Accept", "*/*");
        assertEquals(input, HostRules.apply("https://cdn.example.org/seg1.ts", input));
    }

    @Test
    public void vidzyMediaGetsSignedBrowserIdentity() {
        Map<String, String> out = HostRules.apply("https://s1.vidzy.org/hls/seg-1.ts?token=a",
                headers("origin", "https://movix.luxe", "Accept-Encoding", "gzip, br", "Range", "bytes=0-"));
        assertEquals("https://vidzy.org", out.get("Origin"));
        assertEquals("https://vidzy.org/", out.get("Referer"));
        assertFalse("l'ancienne casse est remplacée, pas doublée", out.containsKey("origin"));
        assertEquals("identity, gzip;q=0, deflate;q=0, br;q=0, zstd;q=0", out.get("Accept-Encoding"));
        assertTrue(out.get("User-Agent").contains("Chrome/140.0.0.0"));
        assertEquals("\"Windows\"", out.get("Sec-Ch-Ua-Platform"));
        assertEquals("cross-site", out.get("Sec-Fetch-Site"));
        assertEquals("bytes=0-", out.get("Range"));
    }

    @Test
    public void nonMediaPathDropsAcceptEncoding() {
        Map<String, String> out = HostRules.apply("https://fsvid.lol/api/source/1", headers("Accept-Encoding", "gzip"));
        assertFalse(out.containsKey("Accept-Encoding"));
        assertEquals("https://fs13.lol", out.get("Origin"));
        assertEquals("https://fsvid.lol", HostRules.apply("https://cdn.fsvid.lol/x.mp4", headers()).get("Origin"));
    }

    @Test
    public void uqloadUsesItsOwnRootAsOrigin() {
        Map<String, String> out = HostRules.apply("https://m180.uqload.is/v.mp4", headers());
        assertEquals("https://uqload.is", out.get("Origin"));
        assertEquals("https://uqload.is/", out.get("Referer"));
    }

    @Test
    public void extractionProvidersGetShortUserAgentAndKeepOnlyGivenClientHints() {
        Map<String, String> out = HostRules.apply("https://veev.to/api/video/1",
                headers("sec-ch-ua", "\"X\";v=\"1\"", "Sec-Ch-Ua-Mobile", ""));
        assertEquals("https://veev.to", out.get("Origin"));
        assertEquals("Mozilla/5.0 Chrome/143.0.0.0", out.get("User-Agent"));
        assertEquals("\"X\";v=\"1\"", out.get("Sec-Ch-Ua"));
        assertFalse("indice vide retiré", out.containsKey("Sec-Ch-Ua-Mobile"));
        assertFalse(out.containsKey("Sec-Ch-Ua-Platform"));
        assertEquals("fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7", out.get("Accept-Language"));
    }

    @Test
    public void inputMapIsNeverMutated() {
        Map<String, String> input = headers("Origin", "https://movix.luxe");
        HostRules.apply("https://vidzy.org/x.m3u8", input);
        assertEquals("https://movix.luxe", input.get("Origin"));
        assertEquals(1, input.size());
    }
}
