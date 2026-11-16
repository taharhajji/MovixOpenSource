package com.mewflix.tv;

import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Relais local (127.0.0.1) par lequel passe tout le trafic de l'appli : pages
 * du WebView et requêtes natives. Son seul rôle est de résoudre les noms par
 * {@link DohResolver} au lieu du DNS de la box. Le trafic HTTPS n'est ni lu ni
 * modifié : la commande CONNECT ouvre un tuyau chiffré de bout en bout.
 */
final class LocalProxy {
    private static final String TAG = "MewflixTV";
    private static final int MAX_HEAD_BYTES = 16 * 1024;
    private static final int HANDSHAKE_TIMEOUT_MS = 15000;
    private static final int CONNECT_TIMEOUT_MS = 10000;
    private static final int BUFFER_BYTES = 32 * 1024;
    private static final int BACKLOG = 64;
    private static final int HTTPS_PORT = 443;
    private static final int HTTP_PORT = 80;
    private static final byte[] LOOPBACK = {127, 0, 0, 1};

    /** Cible d'une requête reçue par le relais. */
    static final class Target {
        final String host;
        final int port;
        /** Première ligne à transmettre (requête HTTP simple), null pour un tunnel CONNECT. */
        final String forwardLine;

        Target(String host, int port, String forwardLine) {
            this.host = host;
            this.port = port;
            this.forwardLine = forwardLine;
        }
    }

    private final ExecutorService pool = Executors.newCachedThreadPool();
    private volatile ServerSocket server;

    /** @return le port d'écoute sur 127.0.0.1 */
    int start() throws IOException {
        final ServerSocket socket = new ServerSocket(0, BACKLOG, InetAddress.getByAddress(LOOPBACK));
        server = socket;
        pool.execute(() -> {
            while (!socket.isClosed()) {
                try {
                    final Socket client = socket.accept();
                    pool.execute(() -> handle(client));
                } catch (IOException closed) {
                    return;
                }
            }
        });
        return socket.getLocalPort();
    }

    void stop() {
        ServerSocket socket = server;
        server = null;
        try {
            if (socket != null) socket.close();
        } catch (IOException ignored) {
            // déjà fermé
        }
        pool.shutdownNow();
    }

    /**
     * Lit la première ligne d'une requête de proxy.
     * « CONNECT hote:443 HTTP/1.1 » ouvre un tunnel ; « GET http://hote/chemin HTTP/1.1 » est relayée telle quelle.
     *
     * @return la cible, ou null si la ligne n'est pas une requête de proxy valide
     */
    static Target parseRequestLine(String line) {
        if (line == null) return null;
        String[] parts = line.trim().split(" ");
        if (parts.length != 3 || !parts[2].startsWith("HTTP/")) return null;
        String method = parts[0].toUpperCase(Locale.ROOT);
        String target = parts[1];
        if (method.equals("CONNECT")) {
            int colon = target.lastIndexOf(':');
            String host = colon >= 0 ? target.substring(0, colon) : target;
            int port = colon >= 0 ? parsePort(target.substring(colon + 1), HTTPS_PORT) : HTTPS_PORT;
            if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length() - 1);
            return host.isEmpty() || port <= 0 ? null : new Target(host, port, null);
        }
        if (!target.regionMatches(true, 0, "http://", 0, "http://".length())) return null;
        String rest = target.substring("http://".length());
        int slash = rest.indexOf('/');
        String authority = slash >= 0 ? rest.substring(0, slash) : rest;
        String path = slash >= 0 ? rest.substring(slash) : "/";
        int colon = authority.lastIndexOf(':');
        String host = colon > 0 ? authority.substring(0, colon) : authority;
        int port = colon > 0 ? parsePort(authority.substring(colon + 1), HTTP_PORT) : HTTP_PORT;
        return host.isEmpty() || port <= 0 ? null : new Target(host, port, parts[0] + " " + path + " " + parts[2]);
    }

    private static int parsePort(String text, int fallback) {
        try {
            int port = Integer.parseInt(text);
            return port > 0 && port <= 65535 ? port : -1;
        } catch (NumberFormatException err) {
            return text.isEmpty() ? fallback : -1;
        }
    }

    private void handle(Socket client) {
        Socket upstream = null;
        try {
            client.setSoTimeout(HANDSHAKE_TIMEOUT_MS);
            InputStream in = client.getInputStream();
            OutputStream out = client.getOutputStream();
            byte[] head = readHead(in);
            String text = new String(head, StandardCharsets.ISO_8859_1);
            int lineEnd = text.indexOf("\r\n");
            Target target = parseRequestLine(lineEnd < 0 ? text : text.substring(0, lineEnd));
            if (target == null) {
                refuse(out, "400 Bad Request");
                return;
            }
            upstream = connect(target);
            if (upstream == null) {
                refuse(out, "502 Bad Gateway");
                return;
            }
            OutputStream toUpstream = upstream.getOutputStream();
            if (target.forwardLine == null) {
                out.write("HTTP/1.1 200 Connection Established\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
                out.flush();
            } else {
                toUpstream.write((target.forwardLine + text.substring(lineEnd)).getBytes(StandardCharsets.ISO_8859_1));
                toUpstream.flush();
            }
            client.setSoTimeout(0);
            final Socket up = upstream;
            pool.execute(() -> pipe(up, client));
            pipe(client, up);
        } catch (IOException | RuntimeException err) {
            // connexion interrompue : rien à signaler, le navigateur réessaie de lui-même
        } finally {
            closeQuietly(client);
            closeQuietly(upstream);
        }
    }

    /** Lit jusqu'à la ligne vide qui termine l'en-tête de la requête. */
    private static byte[] readHead(InputStream in) throws IOException {
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        int matched = 0;
        while (matched < 4) {
            int value = in.read();
            if (value < 0) throw new IOException("requête incomplète");
            head.write(value);
            boolean expected = (matched % 2 == 0) ? value == '\r' : value == '\n';
            matched = expected ? matched + 1 : (value == '\r' ? 1 : 0);
            if (head.size() > MAX_HEAD_BYTES) throw new IOException("en-tête trop long");
        }
        return head.toByteArray();
    }

    private static Socket connect(Target target) {
        final InetAddress[] addresses;
        try {
            addresses = DohResolver.resolve(target.host);
        } catch (IOException unknown) {
            if (BuildConfig.DEBUG) Log.d(TAG, "nom introuvable : " + target.host);
            return null;
        }
        for (InetAddress address : addresses) {
            Socket socket = new Socket();
            try {
                socket.connect(new InetSocketAddress(address, target.port), CONNECT_TIMEOUT_MS);
                socket.setTcpNoDelay(true);
                return socket;
            } catch (IOException unreachable) {
                closeQuietly(socket);
            }
        }
        return null;
    }

    private static void refuse(OutputStream out, String status) throws IOException {
        out.write(("HTTP/1.1 " + status + "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
        out.flush();
    }

    /** Recopie un sens du tuyau ; à la fin, ferme les deux bouts pour libérer l'autre sens. */
    private static void pipe(Socket from, Socket to) {
        try {
            InputStream in = from.getInputStream();
            OutputStream out = to.getOutputStream();
            byte[] buffer = new byte[BUFFER_BYTES];
            int read;
            while ((read = in.read(buffer)) >= 0) {
                out.write(buffer, 0, read);
                out.flush();
            }
        } catch (IOException ended) {
            // l'un des deux bouts a raccroché
        } finally {
            closeQuietly(from);
            closeQuietly(to);
        }
    }

    private static void closeQuietly(Socket socket) {
        try {
            if (socket != null) socket.close();
        } catch (IOException ignored) {
            // déjà fermé
        }
    }
}
