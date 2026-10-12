/**
 * État du service : GET /api/health (réécriture vercel.json → cette fonction).
 *
 * Mesure, depuis le réseau Vercel, ce dont le site dépend :
 *  - l'API Movix (relais /api/*) ;
 *  - le CDN vidéo de la source principale (relais /media) ;
 *  - le relais média lui-même (origine configurée).
 * Utilisé par la page /status et par l'application pour s'expliquer quand
 * quelque chose ne répond pas. Jamais mis en cache.
 */

import { relayConfig } from './media.js';

export const config = { runtime: 'edge' };

const UPSTREAM = (process.env.UPSTREAM_API || 'https://api.movix.luxe').replace(/\/+$/, '');
const CDN_PROBE = process.env.MEDIA_HEALTH_URL || 'https://free.finepulfe.xyz/';
const TIMEOUT_MS = 6000;

async function probe(url, init = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, redirect: 'manual' });
    // 404 sur la racine d'un CDN = joignable ; 401/403 = l'accès nous est refusé.
    const ok = (res.status >= 200 && res.status < 400) || res.status === 404;
    return { ok, status: res.status, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, status: 0, ms: Date.now() - started, error: String(err && err.name === 'AbortError' ? 'timeout' : (err && err.message)) };
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler() {
  const cfg = relayConfig();
  const [api, cdn] = await Promise.all([
    // check-vip sans clé répond 401/400 : l'API est joignable et vivante.
    probe(`${UPSTREAM}/api/check-vip`, { headers: { 'user-agent': 'MewflixHealth/1.0' } }),
    probe(CDN_PROBE, { method: 'HEAD', headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' } }),
  ]);
  const body = {
    status: api.ok && cdn.ok ? 'ok' : api.ok ? 'degraded' : 'down',
    checkedAt: new Date().toISOString(),
    api: { ...api, upstream: UPSTREAM },
    cdn: { ...cdn, probe: CDN_PROBE },
    relay: { mode: cfg.base ? 'external' : 'vercel', base: cfg.base || null, signed: Boolean(cfg.secret), hosts: cfg.hosts },
    build: process.env.VERCEL_GIT_COMMIT_SHA ? process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7) : (process.env.MEWFLIX_BUILD || null),
    region: process.env.VERCEL_REGION || null,
  };
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}
