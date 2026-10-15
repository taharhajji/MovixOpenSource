/**
 * Relais média : /media/<fichier>?u=<URL absolue>[&s=<signature>]
 * (réécriture vercel.json → cette fonction Edge ; même code dans le Worker
 * Cloudflare de web/relay-worker/).
 *
 * Le CDN HLS de la source « pulse » (finepulfe) refuse toute requête portant
 * un en-tête Origin ou Referer étranger aux domaines Movix : un navigateur sur
 * mewflix-app.vercel.app reçoit 403 et le lecteur retombe sur des embeds tiers.
 * Cette fonction va chercher le flux sans Origin ni Referer, le renvoie avec
 * CORS ouvert, et réécrit les playlists HLS (.m3u8) pour que segments, clés et
 * variantes repassent eux aussi par le relais.
 *
 * Deux façons d'être relayé, pour ne jamais servir de proxy ouvert :
 *  - hôtes d'une liste close (MEDIA_RELAY_HOSTS, suffixes séparés par des
 *    virgules ; finepulfe.xyz par défaut) ;
 *  - URL signée (paramètre s = HMAC-SHA256 du u, secret MEDIA_RELAY_SECRET) :
 *    le relais /api/* signe les adresses de flux renvoyées par l'API, et les
 *    playlists réécrites portent des URL signées. Si la team change de CDN,
 *    rien à redéployer.
 *
 * MEDIA_RELAY_BASE (optionnel) : origine d'un relais externe (Worker
 * Cloudflare, sans quota de bande passante). Quand il est défini, la fonction
 * Vercel redirige vers lui au lieu de transférer la vidéo elle-même.
 */

export const config = { runtime: 'edge' };

export const DEFAULT_RELAY_HOSTS = ['finepulfe.xyz'];
export const RELAY_PATH = '/media';

const overrides = {};
/** Configuration explicite (Worker Cloudflare : bindings d'environnement). */
export function configureRelay({ secret, hosts, base } = {}) {
  if (secret !== undefined) overrides.secret = secret;
  if (hosts !== undefined) overrides.hosts = hosts;
  if (base !== undefined) overrides.base = base;
}
function env(name) {
  try { return (typeof process !== 'undefined' && process.env && process.env[name]) || ''; } catch (_) { return ''; }
}
export function relayConfig() {
  const rawHosts = overrides.hosts !== undefined ? overrides.hosts : env('MEDIA_RELAY_HOSTS');
  const hosts = (Array.isArray(rawHosts) ? rawHosts : String(rawHosts || '').split(','))
    .map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  return {
    secret: String(overrides.secret !== undefined ? overrides.secret : env('MEDIA_RELAY_SECRET') || ''),
    hosts: hosts.length ? hosts : DEFAULT_RELAY_HOSTS,
    base: String(overrides.base !== undefined ? overrides.base : env('MEDIA_RELAY_BASE') || '').replace(/\/+$/, ''),
  };
}

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const PLAYLIST_TYPES = /mpegurl|application\/x-mpegurl|audio\/mpegurl|vnd\.apple\.mpegurl/i;
const FORWARD_REQUEST_HEADERS = ['range', 'accept', 'accept-language', 'if-none-match', 'if-modified-since', 'if-range'];
const FORWARD_RESPONSE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control', 'expires', 'date'];
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'Range, Accept, Accept-Language, If-None-Match, If-Modified-Since, If-Range',
  'access-control-expose-headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type, ETag, Last-Modified',
  'access-control-max-age': '86400',
};

export function hostAllowed(hostname, hosts = relayConfig().hosts) {
  const h = String(hostname || '').toLowerCase();
  return hosts.some((suffix) => h === suffix || h.endsWith(`.${suffix}`));
}

// --- Signature HMAC-SHA256 (WebCrypto, disponible sur Edge et Workers) --------
const keyCache = new Map();
async function hmacKey(secret) {
  let key = keyCache.get(secret);
  if (!key) {
    key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keyCache.set(secret, key);
  }
  return key;
}
export async function signUrl(url, secret) {
  if (!secret) return '';
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(String(url)));
  return Array.from(new Uint8Array(sig)).slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}
export async function verifySignature(url, signature, secret) {
  if (!secret || !signature) return false;
  const expected = await signUrl(url, secret);
  if (expected.length !== String(signature).length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ String(signature).charCodeAt(i);
  return diff === 0;
}

function fileNameOf(absoluteUrl) {
  try {
    const segments = new URL(absoluteUrl).pathname.split('/').filter(Boolean);
    return segments.length ? segments[segments.length - 1] : 'media';
  } catch (_) { return 'media'; }
}

/**
 * URL relayée : <relayPath>/<nom de fichier>?u=<URL absolue>[&s=<signature>].
 * Le nom de fichier (master.m3u8, segment-000.ts, subs_fre.vtt…) reste en fin
 * de chemin : le lecteur du site et hls.js décident du traitement d'après
 * l'extension (les sous-titres .vtt déclarés en direct sont enveloppés).
 */
export function relayUrlFor(absoluteUrl, relayPath = RELAY_PATH, signature = '', headersParam = '') {
  const name = encodeURIComponent(fileNameOf(absoluteUrl));
  return `${relayPath}/${name}?u=${encodeURIComponent(absoluteUrl)}`
    + (headersParam ? `&h=${encodeURIComponent(headersParam)}` : '')
    + (signature ? `&s=${signature}` : '');
}

// --- En-têtes amont (TV en direct) ---------------------------------------------
// Certains flux exigent un User-Agent ou un Referer précis (Vavoo : « VAVOO/2.6 »).
// Ils voyagent dans le paramètre h (JSON encodé en base64url), couverts par la
// signature (u + "\n" + h) : seules les URL signées par le relais /api/* peuvent
// les porter, et seuls ces trois en-têtes sont transmis.
const UPSTREAM_HEADER_KEYS = ['user-agent', 'referer', 'origin'];
export function encodeHeadersParam(headers) {
  const clean = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const k = String(key).toLowerCase();
    if (UPSTREAM_HEADER_KEYS.includes(k) && typeof value === 'string' && value) clean[k] = value;
  }
  if (!Object.keys(clean).length) return '';
  return btoa(unescape(encodeURIComponent(JSON.stringify(clean)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodeHeadersParam(param) {
  if (!param) return {};
  try {
    const b64 = String(param).replace(/-/g, '+').replace(/_/g, '/');
    const parsed = JSON.parse(decodeURIComponent(escape(atob(b64))));
    const clean = {};
    for (const [key, value] of Object.entries(parsed || {})) {
      const k = String(key).toLowerCase();
      if (UPSTREAM_HEADER_KEYS.includes(k) && typeof value === 'string' && value.length <= 512) clean[k] = value;
    }
    return clean;
  } catch (_) { return {}; }
}
export function signedPayload(absoluteUrl, headersParam = '') {
  return headersParam ? `${absoluteUrl}\n${headersParam}` : absoluteUrl;
}
export async function signedRelayUrlFor(absoluteUrl, relayPath, secret, headersParam = '') {
  return relayUrlFor(absoluteUrl, relayPath, await signUrl(signedPayload(absoluteUrl, headersParam), secret), headersParam);
}

// Découpe une playlist en morceaux : texte conservé tel quel, et URI à
// remplacer (lignes de segments/variantes, attributs URI="…" des balises
// EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA, EXT-X-I-FRAME-STREAM-INF…).
function splitPlaylist(text) {
  const parts = [];
  const lines = String(text).split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!line.trim()) parts.push({ text: line });
    else if (line.startsWith('#')) {
      for (const piece of line.split(/(URI="[^"]*")/)) {
        const m = /^URI="([^"]*)"$/.exec(piece);
        if (m) parts.push({ uri: m[1], wrap: (u) => `URI="${u}"` });
        else if (piece) parts.push({ text: piece });
      }
    } else parts.push({ uri: line, wrap: (u) => u });
    if (index < lines.length - 1) parts.push({ text: '\n' });
  });
  return parts;
}
function joinPlaylist(parts, resolved) {
  let out = '';
  let i = 0;
  for (const part of parts) out += part.uri !== undefined ? part.wrap(resolved[i++]) : part.text;
  return out;
}
function absoluteOf(uri, baseUrl) {
  const trimmed = String(uri).trim();
  if (!trimmed || /^data:/i.test(trimmed)) return null;
  try { return new URL(trimmed, baseUrl).href; } catch (_) { return null; }
}

/** Réécriture synchrone (URL non signées : hôtes de la liste close). */
export function rewritePlaylist(text, baseUrl, relayPath = RELAY_PATH) {
  const parts = splitPlaylist(text);
  const resolved = parts.filter((p) => p.uri !== undefined).map((p) => {
    const abs = absoluteOf(p.uri, baseUrl);
    return abs ? relayUrlFor(abs, relayPath) : p.uri;
  });
  return joinPlaylist(parts, resolved);
}
/** Réécriture avec URL signées quand un secret est configuré. */
export async function rewritePlaylistSigned(text, baseUrl, relayPath = RELAY_PATH, secret = '', headersParam = '') {
  if (!secret) return rewritePlaylist(text, baseUrl, relayPath);
  const parts = splitPlaylist(text);
  const resolved = await Promise.all(parts.filter((p) => p.uri !== undefined).map(async (p) => {
    const abs = absoluteOf(p.uri, baseUrl);
    return abs ? signedRelayUrlFor(abs, relayPath, secret, headersParam) : p.uri;
  }));
  return joinPlaylist(parts, resolved);
}

function isPlaylist(url, contentType) {
  if (PLAYLIST_TYPES.test(contentType || '')) return true;
  try { return /\.m3u8?$/i.test(new URL(url).pathname); } catch (_) { return false; }
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS } });
}

/**
 * Origine publique du site (hôte vu par le visiteur, pas l'URL interne du
 * déploiement) : les playlists réécrites portent des URL absolues, car hls.js
 * résout les URI relatives contre l'URL d'origine du flux, pas contre le relais.
 */
export function publicOrigin(request) {
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || new URL(request.url).host;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
  const proto = request.headers.get('x-forwarded-proto') || (local ? 'http' : 'https');
  return `${proto.split(',')[0].trim()}://${host}`;
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET' && request.method !== 'HEAD') return json(405, { error: 'method_not_allowed' });

  const cfg = relayConfig();
  const url = new URL(request.url);
  const raw = url.searchParams.get('u') || '';
  const signature = url.searchParams.get('s') || '';
  const headersParam = url.searchParams.get('h') || '';
  let target;
  try {
    target = new URL(raw);
  } catch (_) {
    return json(400, { error: 'bad_url' });
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return json(400, { error: 'bad_url' });
  const signed = await verifySignature(signedPayload(target.href, headersParam), signature, cfg.secret);
  const allowed = signed || (!headersParam && hostAllowed(target.hostname, cfg.hosts));
  if (!allowed) return json(403, { error: 'host_not_relayed', host: target.hostname });
  const upstreamHeaders = signed ? decodeHeadersParam(headersParam) : {};

  // Relais externe configuré (Worker Cloudflare) : on lui passe la main.
  const origin = publicOrigin(request);
  if (cfg.base && cfg.base !== origin) {
    const sig = signature || await signUrl(signedPayload(target.href, headersParam), cfg.secret);
    return Response.redirect(`${cfg.base}${relayUrlFor(target.href, RELAY_PATH, sig, headersParam)}`, 302);
  }

  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('user-agent', BROWSER_UA);
  for (const [key, value] of Object.entries(upstreamHeaders)) headers.set(key, value);
  if (!headers.has('accept')) headers.set('accept', '*/*');

  let upstream;
  try {
    upstream = await fetch(target.href, { method: request.method, headers, redirect: 'follow' });
  } catch (err) {
    return json(502, { error: 'upstream_unreachable', detail: String(err && err.message) });
  }

  const out = new Headers(CORS);
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  out.set('x-mewflix-relay', '1');

  const contentType = upstream.headers.get('content-type') || '';
  if (upstream.ok && request.method === 'GET' && isPlaylist(upstream.url || target.href, contentType)) {
    const text = await upstream.text();
    const body = await rewritePlaylistSigned(text, upstream.url || target.href, `${origin}${RELAY_PATH}`, cfg.secret, signed ? headersParam : '');
    out.delete('content-length');
    out.delete('content-range');
    out.set('content-type', 'application/vnd.apple.mpegurl');
    out.set('cache-control', 'no-store');
    return new Response(body, { status: upstream.status, headers: out });
  }

  if (!upstream.ok) {
    // Pas de page HTML du CDN dans le lecteur : une erreur courte, statut conservé.
    out.set('content-type', 'text/plain; charset=utf-8');
    out.delete('content-length');
    return new Response(`relay upstream ${upstream.status}`, { status: upstream.status, headers: out });
  }
  // Segments immuables : cache navigateur une heure, cache réseau un jour (un
  // seul transfert depuis l'origine pour tous les spectateurs d'un même titre).
  out.set('cache-control', 'public, max-age=3600, s-maxage=86400, immutable');
  return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: out });
}
