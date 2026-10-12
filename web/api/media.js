/**
 * Relais média Edge : /media/<fichier>?u=<URL absolue> (réécriture vercel.json).
 *
 * Le CDN HLS de la source « pulse » (finepulfe) refuse toute requête portant
 * un en-tête Origin ou Referer étranger aux domaines Movix : un navigateur sur
 * mewflix-app.vercel.app reçoit 403 et le lecteur retombe sur des embeds tiers.
 * Cette fonction va chercher le flux sans Origin ni Referer, le renvoie avec
 * CORS ouvert, et réécrit les playlists HLS (.m3u8) pour que segments, clés et
 * variantes repassent eux aussi par le relais.
 *
 * Hôtes relayés : liste close (MEDIA_RELAY_HOSTS, suffixes séparés par des
 * virgules) pour ne pas servir de proxy ouvert. Les URL produites par la
 * réécriture d'une playlist pointent toujours vers ces mêmes hôtes.
 *
 * Rustine pour la phase de test : chaque octet vidéo transite par Vercel
 * (quota « Fast Origin Transfer »). La vraie solution est l'ajout du domaine
 * dans la liste d'origines autorisées du CDN, côté team.
 */

export const config = { runtime: 'edge' };

export const DEFAULT_RELAY_HOSTS = ['finepulfe.xyz'];
export const RELAY_PATH = '/media';

const RELAY_HOSTS = (typeof process !== 'undefined' && process.env && process.env.MEDIA_RELAY_HOSTS
  ? process.env.MEDIA_RELAY_HOSTS.split(',')
  : DEFAULT_RELAY_HOSTS).map((s) => s.trim().toLowerCase()).filter(Boolean);

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

export function hostAllowed(hostname, hosts = RELAY_HOSTS) {
  const h = String(hostname || '').toLowerCase();
  return hosts.some((suffix) => h === suffix || h.endsWith(`.${suffix}`));
}

/**
 * URL relayée : /media/<nom de fichier>?u=<URL absolue>. Le nom de fichier
 * (master.m3u8, segment-000.ts, subs_fre.vtt…) reste en fin de chemin : le
 * lecteur du site et hls.js décident du traitement d'après l'extension (les
 * sous-titres .vtt déclarés en direct sont enveloppés dans une playlist).
 */
export function relayUrlFor(absoluteUrl, relayPath = RELAY_PATH) {
  let name = 'media';
  try {
    const segments = new URL(absoluteUrl).pathname.split('/').filter(Boolean);
    if (segments.length) name = segments[segments.length - 1];
  } catch (_) { /* nom générique */ }
  return `${relayPath}/${encodeURIComponent(name)}?u=${encodeURIComponent(absoluteUrl)}`;
}

/**
 * Réécrit une playlist HLS : chaque URI (lignes de segments / variantes et
 * attributs URI="…" des balises EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA, EXT-X-I-FRAME-STREAM-INF…)
 * devient une URL relative au relais. Les URI relatives sont résolues contre `baseUrl`.
 */
export function rewritePlaylist(text, baseUrl, relayPath = RELAY_PATH) {
  const toRelay = (uri) => {
    const trimmed = String(uri).trim();
    if (!trimmed || /^data:/i.test(trimmed)) return uri;
    try {
      const absolute = new URL(trimmed, baseUrl).href;
      return relayUrlFor(absolute, relayPath);
    } catch (_) {
      return uri;
    }
  };
  return String(text).split(/\r?\n/).map((line) => {
    if (!line.trim()) return line;
    if (line.startsWith('#')) {
      return line.replace(/URI="([^"]*)"/g, (_m, uri) => `URI="${toRelay(uri)}"`);
    }
    return toRelay(line);
  }).join('\n');
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

function isPlaylist(url, contentType) {
  if (PLAYLIST_TYPES.test(contentType || '')) return true;
  try { return /\.m3u8?$/i.test(new URL(url).pathname); } catch (_) { return false; }
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS } });
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET' && request.method !== 'HEAD') return json(405, { error: 'method_not_allowed' });

  const raw = new URL(request.url).searchParams.get('u') || '';
  let target;
  try {
    target = new URL(raw);
  } catch (_) {
    return json(400, { error: 'bad_url' });
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return json(400, { error: 'bad_url' });
  if (!hostAllowed(target.hostname)) return json(403, { error: 'host_not_relayed', host: target.hostname });

  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('user-agent', BROWSER_UA);
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
    const body = rewritePlaylist(text, upstream.url || target.href, publicOrigin(request) + RELAY_PATH);
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
  if (!out.has('cache-control')) out.set('cache-control', 'public, max-age=3600');
  return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: out });
}
