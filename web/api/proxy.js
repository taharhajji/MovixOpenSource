/**
 * Relais Edge vers l'API Movix (fichier api/proxy.js, atteint par la réécriture
 * /api/:path* de vercel.json).
 *
 * L'API n'accepte que les origines Movix (middleware CORS) : un site servi
 * depuis un autre domaine ne peut pas l'appeler directement depuis le
 * navigateur (403 « Not allowed by CORS »). Le front MEWFLIX appelle donc son
 * propre domaine (/api/…), et cette fonction retransmet la requête à l'API
 * sans l'en-tête Origin — qu'elle accepte, comme pour une app mobile.
 *
 * Résilience :
 *  - reprises automatiques (3 tentatives) sur panne réseau ou 502/503/504 pour
 *    les lectures ;
 *  - catalogue (TMDB, tendances, liens…) mis en cache sur le réseau Vercel et
 *    servi périmé quand l'API tousse (stale-while-revalidate / stale-if-error) ;
 *  - adresses de flux « pulse » réécrites vers le relais média signé, pour
 *    que la lecture survive à un changement de CDN côté team.
 *
 * Runtime Edge : réponse en flux (pas de limite de taille), méthodes et corps
 * conservés, cookies et en-têtes de l'API renvoyés tels quels.
 */

import { RELAY_PATH, encodeHeadersParam, hostAllowed, publicOrigin, relayConfig, relayUrlFor, signUrl, signedPayload } from './media.js';

export const config = { runtime: 'edge' };

const UPSTREAM = (process.env.UPSTREAM_API || 'https://api.movix.luxe').replace(/\/+$/, '');

const DROP_REQUEST_HEADERS = new Set([
  'host', 'origin', 'referer', 'connection', 'content-length', 'accept-encoding',
  'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-ipcountry', 'true-client-ip',
]);
const DROP_RESPONSE_HEADERS = new Set([
  'access-control-allow-origin', 'access-control-allow-credentials', 'access-control-allow-headers',
  'access-control-allow-methods', 'access-control-expose-headers', 'content-encoding',
  'content-length', 'transfer-encoding', 'connection', 'keep-alive',
]);

// Lectures de catalogue sans état utilisateur : cache réseau (5 min), servi
// périmé pendant un jour en cas de panne de l'API. Jamais pour les flux
// (liés à l'IP) ni pour tout ce qui porte une identité.
const CACHEABLE_PREFIXES = ['tmdb/', 'imdb/', 'trending/', 'cinegraph/', 'links/', 'genres', 'collection/', 'person/', 'search'];
const IDENTITY_HEADERS = ['authorization', 'x-access-key', 'cookie', 'x-session'];
const CACHE_CONTROL = 'public, s-maxage=300, stale-while-revalidate=86400, stale-if-error=604800';
const RETRY_DELAYS_MS = [250, 800];

function isCacheable(request, apiPath) {
  if (request.method !== 'GET') return false;
  if (!CACHEABLE_PREFIXES.some((p) => apiPath.startsWith(p))) return false;
  return !IDENTITY_HEADERS.some((h) => request.headers.get(h));
}

async function fetchWithRetry(target, init, retriable) {
  let lastError = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(target, init);
      if (!retriable || attempt === RETRY_DELAYS_MS.length || ![502, 503, 504].includes(res.status)) return res;
      lastError = new Error(`upstream ${res.status}`);
    } catch (err) {
      lastError = err;
      if (!retriable || attempt === RETRY_DELAYS_MS.length) throw err;
    }
    await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
  }
  throw lastError || new Error('upstream failed');
}

/**
 * Réponses « sources de flux » : chaque URL http(s) est remplacée par son
 * équivalent relayé (signé quand un secret existe, sinon seulement les hôtes
 * de la liste close). Le lecteur voit ainsi des adresses de son propre
 * domaine : plus de blocage Origin, et un changement de CDN passe inaperçu.
 */
export async function rewriteStreamSources(payload, relayBase, cfg, headersFor = () => ({})) {
  let changed = false;
  async function relayed(url, owner) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return url;
    // Signée sur la forme normalisée (new URL().href), celle que le relais vérifie.
    let normalized;
    try { normalized = new URL(url); } catch (_) { return url; }
    // Déjà relayée (flux extrait, ou réponse réécrite deux fois) : telle quelle.
    if (normalized.href.startsWith(`${relayBase}/`)) return url;
    const headersParam = cfg.secret ? encodeHeadersParam(headersFor(owner) || {}) : '';
    if (!cfg.secret && !hostAllowed(normalized.hostname, cfg.hosts)) return url;
    changed = true;
    const signature = await signUrl(signedPayload(normalized.href, headersParam), cfg.secret);
    return `${relayBase}${relayUrlFor(normalized.href, '', signature, headersParam)}`;
  }
  async function walk(node) {
    if (Array.isArray(node)) { for (const item of node) await walk(item); return; }
    if (!node || typeof node !== 'object') return;
    if (node._isEmbed === true) return; // lecteur en iframe : rien à relayer
    if (node._mewflixExtracted === true) return; // déjà relayé et signé
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (key === 'url' && typeof value === 'string') node[key] = await relayed(value, node);
      else if (value && typeof value === 'object') await walk(value);
    }
  }
  await walk(payload);
  return changed;
}

function isStreamSourcesPath(apiPath) {
  return /^purstream\/(movie|tv)\//.test(apiPath) && /\/stream(\?|$)/.test(apiPath);
}
function isLiveStreamPath(apiPath) {
  return /^livetv\/stream\//.test(apiPath);
}

// TV en direct : les flux Vavoo (IP nue, http, port 8008) exigent le
// User-Agent « VAVOO/2.6 » ; d'autres sources imposent un Referer. Sans
// extension, un navigateur ne peut ni poser ces en-têtes ni charger du http
// depuis une page https : le relais s'en charge, avec les en-têtes signés.
const VAVOO_USER_AGENT = 'VAVOO/2.6';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// Northlive : l'API renvoie une page lecteur à mettre en iframe, avec ses
// propres publicités. La page expose un jeton de lecture (PLAY_TOKEN) et une
// clé ; un appel play_url donne l'adresse HLS, lisible avec un Referer. On la
// relaie signée, en première position : le lecteur du site la joue lui-même,
// sans publicité. L'iframe reste en secours.
const NORTHLIVE_PLAYER_RE = /^https:\/\/northlive\.lol\/api\/v1\/tv\/([^/?#]+)\/player\?/i;
const northliveCache = new Map();
const NORTHLIVE_CACHE_MS = 4 * 60 * 1000;

export async function extractNorthlive(playerUrl, fetchImpl = fetch) {
  const m = NORTHLIVE_PLAYER_RE.exec(playerUrl);
  if (!m) return null;
  const cached = northliveCache.get(playerUrl);
  if (cached && cached.until > Date.now()) return cached.value;
  const slug = decodeURIComponent(m[1]);
  const apiKey = new URL(playerUrl).searchParams.get('api_key') || '';
  const headers = { 'user-agent': BROWSER_UA, referer: playerUrl, origin: 'https://northlive.lol' };
  const page = await fetchImpl(playerUrl, { headers: { 'user-agent': BROWSER_UA, accept: 'text/html' } });
  if (!page.ok) return null;
  const html = await page.text();
  const token = /const PLAY_TOKEN = "([^"]*)"/.exec(html);
  const playToken = token ? token[1] : '';
  const body = { slug };
  if (apiKey) body.api_key = apiKey;
  if (playToken) body.play_token = playToken;
  const res = await fetchImpl(`https://northlive.lol/api/v1/index.php?route=play_url${apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : ''}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  let data;
  try { data = await res.json(); } catch (_) { return null; }
  if (!data || !data.success || typeof data.url !== 'string') return null;
  let url = data.url;
  if (playToken && !/[?&]pt=/.test(url)) url += `${url.includes('?') ? '&' : '?'}pt=${encodeURIComponent(playToken)}`;
  const value = { url, headers, direct: Boolean(data.direct) };
  northliveCache.set(playerUrl, { value, until: Date.now() + NORTHLIVE_CACHE_MS });
  if (northliveCache.size > 200) northliveCache.delete(northliveCache.keys().next().value);
  return value;
}

/** Ajoute, devant chaque lecteur Northlive en iframe, le flux HLS extrait (relayé, signé). */
export async function addNorthliveDirectStreams(payload, relayBase, cfg, fetchImpl = fetch) {
  if (!payload || !Array.isArray(payload.streams) || !cfg.secret) return false;
  const additions = [];
  for (const stream of payload.streams) {
    if (!stream || typeof stream !== 'object' || !stream._isEmbed || typeof stream.url !== 'string') continue;
    if (!NORTHLIVE_PLAYER_RE.test(stream.url)) continue;
    let extracted = null;
    try { extracted = await extractNorthlive(stream.url, fetchImpl); } catch (_) { extracted = null; }
    if (!extracted) continue;
    const headersParam = encodeHeadersParam(extracted.headers);
    const href = new URL(extracted.url).href;
    const signature = await signUrl(signedPayload(href, headersParam), cfg.secret);
    additions.push({
      title: `${stream.title || 'northlive'} · sans pub`,
      url: `${relayBase}${relayUrlFor(href, '', signature, headersParam)}`,
      _directPlay: true,
      _mewflixExtracted: true,
      behaviorHints: { notWebReady: false },
    });
  }
  if (!additions.length) return false;
  payload.streams = [...additions, ...payload.streams];
  return true;
}

export function liveStreamHeaders(stream) {
  const headers = {};
  if (!stream || typeof stream !== 'object') return headers;
  const url = typeof stream.url === 'string' ? stream.url : '';
  if (typeof stream.referer === 'string' && stream.referer) {
    headers.referer = stream.referer;
    try { headers.origin = new URL(stream.referer).origin; } catch (_) { /* referer invalide */ }
  }
  if (typeof stream.userAgent === 'string' && stream.userAgent) headers['user-agent'] = stream.userAgent;
  else if (stream._directPlay === true || url.includes('/sunshine/')) headers['user-agent'] = VAVOO_USER_AGENT;
  return headers;
}

export default async function handler(request) {
  const url = new URL(request.url);
  // Réécriture vercel.json : /api/:path* → /api/proxy?path=:path* (une route
  // « attrape-tout » [...path] ne couvrait qu'un segment). Le chemin d'origine
  // arrive dans `path`, les autres paramètres sont transmis tels quels.
  const params = new URLSearchParams(url.search);
  const apiPath = params.get('path') || '';
  params.delete('path');
  const query = params.toString();
  const target = `${UPSTREAM}/api/${apiPath}${query ? `?${query}` : ''}`;

  const headers = new Headers();
  for (const [name, value] of request.headers) {
    const key = name.toLowerCase();
    if (DROP_REQUEST_HEADERS.has(key) || key.startsWith('x-vercel-') || key.startsWith('x-forwarded-')) continue;
    headers.set(name, value);
  }
  // Adresse IP du spectateur : certains flux résolus par l'API sont liés à
  // l'IP du client qui les demande. Sans cela, l'API verrait l'IP du relais et
  // le navigateur recevrait des URL valables pour une autre adresse.
  const clientIp = (request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || '').split(',')[0].trim();
  if (clientIp) {
    headers.set('x-forwarded-for', clientIp);
    headers.set('x-real-ip', clientIp);
    headers.set('true-client-ip', clientIp);
  }
  // L'API classe les sessions par User-Agent : on signale le client web MEWFLIX
  // sans masquer le navigateur réel.
  const ua = request.headers.get('user-agent') || '';
  if (ua && !/MewflixWeb\//.test(ua)) headers.set('user-agent', `${ua} MewflixWeb/1.0`);

  const readOnly = request.method === 'GET' || request.method === 'HEAD';
  const init = { method: request.method, headers, redirect: 'manual' };
  if (!readOnly) {
    init.body = request.body;
    init.duplex = 'half';
  }

  let upstream;
  try {
    upstream = await fetchWithRetry(target, init, readOnly);
  } catch (err) {
    return new Response(JSON.stringify({ error: 'upstream_unreachable', detail: String(err && err.message) }), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  const responseHeaders = new Headers();
  for (const [name, value] of upstream.headers) {
    if (DROP_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    responseHeaders.append(name, value);
  }
  // Une redirection de l'API vers elle-même doit rester derrière le relais.
  const location = upstream.headers.get('location');
  if (location && location.startsWith(UPSTREAM)) {
    responseHeaders.set('location', location.slice(UPSTREAM.length) || '/');
  }
  responseHeaders.set('x-mewflix-proxy', '1');

  if (upstream.status === 200 && isCacheable(request, apiPath) && !upstream.headers.get('set-cookie')) {
    responseHeaders.set('cache-control', CACHE_CONTROL);
    responseHeaders.set('vercel-cdn-cache-control', CACHE_CONTROL);
  } else if (!responseHeaders.has('cache-control')) {
    responseHeaders.set('cache-control', 'no-store');
  }

  // Flux « pulse » : adresses réécrites vers le relais média.
  const liveStreams = isLiveStreamPath(apiPath);
  if (upstream.status === 200 && request.method === 'GET' && (isStreamSourcesPath(apiPath) || liveStreams)
      && /json/i.test(upstream.headers.get('content-type') || '')) {
    try {
      const payload = await upstream.clone().json();
      const cfg = relayConfig();
      const relayBase = `${cfg.base || publicOrigin(request)}${RELAY_PATH}`;
      if (liveStreams) await addNorthliveDirectStreams(payload, relayBase, cfg);
      await rewriteStreamSources(payload, relayBase, cfg, liveStreams ? liveStreamHeaders : undefined);
      responseHeaders.set('content-type', 'application/json; charset=utf-8');
      responseHeaders.set('cache-control', 'no-store');
      responseHeaders.set('x-mewflix-relay-sources', '1');
      return new Response(JSON.stringify(payload), { status: 200, headers: responseHeaders });
    } catch (_) {
      // Forme inattendue : la réponse d'origine passe telle quelle (clone intact).
      responseHeaders.set('cache-control', 'no-store');
      return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
    }
  }

  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
}
