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

import { RELAY_PATH, hostAllowed, publicOrigin, relayConfig, relayUrlFor, signUrl } from './media.js';

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
export async function rewriteStreamSources(payload, relayBase, cfg) {
  let changed = false;
  async function relayed(url) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return url;
    // Signée sur la forme normalisée (new URL().href), celle que le relais vérifie.
    let normalized;
    try { normalized = new URL(url); } catch (_) { return url; }
    if (!cfg.secret && !hostAllowed(normalized.hostname, cfg.hosts)) return url;
    changed = true;
    return `${relayBase}${relayUrlFor(normalized.href, '', await signUrl(normalized.href, cfg.secret))}`;
  }
  async function walk(node) {
    if (Array.isArray(node)) { for (const item of node) await walk(item); return; }
    if (!node || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (key === 'url' && typeof value === 'string') node[key] = await relayed(value);
      else if (value && typeof value === 'object') await walk(value);
    }
  }
  await walk(payload);
  return changed;
}

function isStreamSourcesPath(apiPath) {
  return /^purstream\/(movie|tv)\//.test(apiPath) && /\/stream(\?|$)/.test(apiPath);
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
  if (upstream.status === 200 && request.method === 'GET' && isStreamSourcesPath(apiPath)
      && /json/i.test(upstream.headers.get('content-type') || '')) {
    try {
      const payload = await upstream.clone().json();
      const cfg = relayConfig();
      const relayBase = `${cfg.base || publicOrigin(request)}${RELAY_PATH}`;
      await rewriteStreamSources(payload, relayBase, cfg);
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
