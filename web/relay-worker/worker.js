/**
 * Relais média MEWFLIX sur Cloudflare Workers : même code que la fonction
 * Edge Vercel (web/api/media.js), sans quota de bande passante (offre
 * gratuite : 100 000 requêtes par jour, soit ≈ 110 heures de lecture).
 *
 *   cd web/relay-worker && npx wrangler login && npm run deploy
 *   npx wrangler secret put MEDIA_RELAY_SECRET   (même valeur que sur Vercel)
 *
 * Puis, sur Vercel : MEDIA_RELAY_BASE=https://<worker>.workers.dev — la
 * fonction /media redirige vers ce Worker et le relais /api/* signe les
 * adresses de flux directement vers lui.
 */

import handler, { configureRelay } from '../api/media.js';

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
    if (!url.pathname.startsWith('/media')) return new Response('not found', { status: 404 });
    return handler(request);
  },
};
