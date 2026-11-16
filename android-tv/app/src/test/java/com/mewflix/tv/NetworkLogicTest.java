package com.mewflix.tv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Lecture des réponses du DNS chiffré et des requêtes reçues par le relais local. */
public class NetworkLogicTest {
    @Test
    public void parsesCloudflareAnswerAndKeepsTheShortestTtl() throws Exception {
        DohResolver.Answer answer = DohResolver.parse("{\"Status\":0,\"Answer\":["
                + "{\"name\":\"exemple.org\",\"type\":1,\"TTL\":100,\"data\":\"192.0.2.10\"},"
                + "{\"name\":\"exemple.org\",\"type\":1,\"TTL\":40,\"data\":\"192.0.2.11\"}]}");
        assertEquals(2, answer.addresses.size());
        assertEquals("192.0.2.10", answer.addresses.get(0));
        assertEquals(40, answer.ttlSeconds);
    }

    @Test
    public void ignoresAliasesAndMalformedRecords() throws Exception {
        DohResolver.Answer answer = DohResolver.parse("{\"Status\":0,\"Answer\":["
                + "{\"name\":\"www.exemple.org\",\"type\":5,\"TTL\":300,\"data\":\"exemple.org.\"},"
                + "{\"name\":\"exemple.org\",\"type\":1,\"TTL\":300,\"data\":\"pas-une-adresse\"},"
                + "{\"name\":\"exemple.org\",\"type\":1,\"TTL\":300,\"data\":\"192.0.2.20\"}]}");
        assertEquals(1, answer.addresses.size());
        assertEquals("192.0.2.20", answer.addresses.get(0));
    }

    @Test
    public void blockedOrUnknownNameGivesNoAddress() throws Exception {
        assertTrue(DohResolver.parse("{\"Status\":3,\"Question\":[{\"name\":\"inconnu.example\",\"type\":1}]}").addresses.isEmpty());
        assertTrue(DohResolver.parse("{}").addresses.isEmpty());
    }

    @Test
    public void ipLiteralsAreNeverLookedUp() {
        assertTrue(DohResolver.isIpLiteral("1.1.1.1"));
        assertTrue(DohResolver.isIpLiteral("::1"));
        assertFalse(DohResolver.isIpLiteral("movix.luxe"));
        assertFalse(DohResolver.isIpLiteral("1.1.1.example"));
        assertFalse(DohResolver.isIpLiteral(null));
    }

    @Test
    public void connectRequestOpensATunnel() {
        LocalProxy.Target target = LocalProxy.parseRequestLine("CONNECT movix.luxe:443 HTTP/1.1");
        assertEquals("movix.luxe", target.host);
        assertEquals(443, target.port);
        assertNull("tunnel : rien à réécrire", target.forwardLine);
        assertEquals(8443, LocalProxy.parseRequestLine("CONNECT cdn.example.org:8443 HTTP/1.1").port);
        assertEquals("::1", LocalProxy.parseRequestLine("CONNECT [::1]:443 HTTP/1.1").host);
    }

    @Test
    public void plainHttpRequestIsForwardedWithARelativePath() {
        LocalProxy.Target target = LocalProxy.parseRequestLine("GET http://exemple.org:8080/a/b?c=1 HTTP/1.1");
        assertEquals("exemple.org", target.host);
        assertEquals(8080, target.port);
        assertEquals("GET /a/b?c=1 HTTP/1.1", target.forwardLine);
        LocalProxy.Target root = LocalProxy.parseRequestLine("GET http://exemple.org HTTP/1.0");
        assertEquals(80, root.port);
        assertEquals("GET / HTTP/1.0", root.forwardLine);
    }

    @Test
    public void invalidRequestLinesAreRejected() {
        assertNull(LocalProxy.parseRequestLine(null));
        assertNull(LocalProxy.parseRequestLine(""));
        assertNull(LocalProxy.parseRequestLine("GET /chemin HTTP/1.1"));
        assertNull(LocalProxy.parseRequestLine("CONNECT movix.luxe:0 HTTP/1.1"));
        assertNull(LocalProxy.parseRequestLine("CONNECT movix.luxe:99999 HTTP/1.1"));
        assertNull(LocalProxy.parseRequestLine("CONNECT :443 HTTP/1.1"));
        assertNull(LocalProxy.parseRequestLine("CONNECT movix.luxe:443"));
        assertNull(LocalProxy.parseRequestLine("GET ftp://exemple.org/x HTTP/1.1"));
    }
}
