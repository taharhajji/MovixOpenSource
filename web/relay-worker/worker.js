/**
 * Worker Cloudflare MEWFLIX — tout ce qui est lourd pour la version web :
 *
 *  - fichiers statiques (bundles JS/CSS, avatars, images, wasm) : servis par
 *    Cloudflare avant même ce script (dossier site-assets/, gratuit et illimité) ;
 *  - /api/*  : relais vers l'API Movix sans Origin (même code que web/api/proxy.js),
 *    ouvert en CORS aux seuls sites listés dans ALLOWED_ORIGINS ;
 *  - /media  : relais vidéo signé (même code que web/api/media.js).
 *
 * Le site (Netlify) ne sert que sa page d'accueil : aucune vidéo ni aucun gros
 * fichier n'y transite. Offre gratuite Cloudflare : 100 000 exécutions du script
 * par jour (API + segments vidéo), sans facturation possible au-delà.
 *
 *   cd web/relay-worker && npx wrangler deploy
 *   npx wrangler secret put MEDIA_RELAY_SECRET
 */

import mediaHandler, { configureRelay } from '../api/media.js';
import proxyHandler from '../api/proxy.js';

const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
const API_METHODS = 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS';
const PREFLIGHT_MAX_AGE = '86400';

function allowedOrigin(request, env) {
  const origin = request.headers.get('origin') || '';
  if (!origin) return '';
  const list = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  return list.includes(origin) || LOCAL_ORIGIN.test(origin) ? origin : '';
}

function withCors(response, origin) {
  const headers = new Headers(response.headers);
  if (origin) {
    headers.set('access-control-allow-origin', origin);
    headers.set('access-control-expose-headers', 'Content-Type, Content-Length, Retry-After');
  }
  headers.append('vary', 'Origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function preflight(request, origin) {
  if (!origin) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': API_METHODS,
      'access-control-allow-headers': request.headers.get('access-control-request-headers') || 'Content-Type, Authorization',
      'access-control-max-age': PREFLIGHT_MAX_AGE,
      vary: 'Origin',
    },
  });
}

/** /api/<chemin>?q → forme attendue par proxy.js (/api/proxy?path=<chemin>&q). */
function toProxyRequest(request, url) {
  const target = new URL(url.origin);
  target.pathname = '/api/proxy';
  target.search = url.search;
  target.searchParams.set('path', url.pathname.replace(/^\/api\/?/, ''));
  const headers = new Headers(request.headers);
  // Les flux renvoyés par l'API sont liés à l'IP de celui qui les demande.
  const clientIp = request.headers.get('cf-connecting-ip');
  if (clientIp) headers.set('x-forwarded-for', clientIp);
  headers.delete('origin');
  const init = { method: request.method, headers, redirect: 'manual' };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
    init.duplex = 'half';
  }
  return new Request(target.toString(), init);
}

export default {
  async fetch(request, env) {
    configureRelay({
      secret: env.MEDIA_RELAY_SECRET || '',
      hosts: env.MEDIA_RELAY_HOSTS || undefined,
      base: '',
    });
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, service: 'mewflix-media-relay', signed: Boolean(env.MEDIA_RELAY_SECRET) }), {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const origin = allowedOrigin(request, env);
      if (request.method === 'OPTIONS') return preflight(request, origin);
      const response = await proxyHandler(toProxyRequest(request, url));
      return withCors(response, origin);
    }
    if (url.pathname.startsWith('/media')) return mediaHandler(request);
    return new Response('not found', { status: 404 });
  },
};
