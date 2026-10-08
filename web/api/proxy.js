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
 * Runtime Edge : réponse en flux (pas de limite de taille), méthodes et corps
 * conservés, cookies et en-têtes de l'API renvoyés tels quels.
 */

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

  const init = { method: request.method, headers, redirect: 'manual' };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
    init.duplex = 'half';
  }

  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (err) {
    return new Response(JSON.stringify({ error: 'upstream_unreachable', detail: String(err && err.message) }), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8' },
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

  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
}
