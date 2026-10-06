import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  FALLBACK_CONFIG,
  normalizeAddressJson,
  parseRentry,
  resolveAddressConfig,
  withKnownMirrors,
} = require('../src/lib/addressResolver.js');

const ADDRESS_JSON = {
  version: 1,
  primary: { url: 'https://movix.luxe', label: 'movix.luxe' },
  active: [
    { id: 'luxe', url: 'https://movix.luxe' },
    { id: 'college', url: 'https://movix.college' },
    { id: 'men', url: 'https://movix.men' },
  ],
  blocked: [{ id: 'tax', url: 'https://movix.tax' }],
  github: 'https://github.com/movixstream/MovixOpenSource',
  telegram: 'https://t.me/movix_site',
};

function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!key) return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
    const route = routes[key];
    if (route instanceof Error) throw route;
    return {
      ok: route.status ? route.status < 400 : true,
      status: route.status || 200,
      text: async () => route.body,
      json: async () => JSON.parse(route.body),
    };
  };
  return { fetchImpl, calls };
}

test('parseRentry : JSON puis HTML (premier <article>), rentry exclu', () => {
  assert.equal(parseRentry('{"mirrors":["rentry.co","MOVIX.online "]}'), 'movix.online');
  const html = '<nav><a href="https://rentry.co/x">x</a></nav><article><p><a href="https://movix.online/">Movix</a></p></article>';
  assert.equal(parseRentry(html), 'movix.online');
  assert.equal(parseRentry('<p>rien</p>'), null);
});

test('normalizeAddressJson : primaire exclu des miroirs, bloqués ignorés', () => {
  const cfg = normalizeAddressJson(ADDRESS_JSON);
  assert.equal(cfg.primaryUrl, 'https://movix.luxe');
  assert.deepEqual(cfg.mirrors, ['https://movix.college', 'https://movix.men']);
  assert.equal(normalizeAddressJson({ primary: { url: 'x' } }), null);
});

test('withKnownMirrors complète avec la liste codée en dur, sans doublon', () => {
  const cfg = withKnownMirrors(normalizeAddressJson(ADDRESS_JSON));
  assert.equal(new Set([cfg.primaryUrl, ...cfg.mirrors]).size, cfg.mirrors.length + 1);
  for (const url of FALLBACK_CONFIG.MIRRORS) assert.ok(cfg.mirrors.includes(url) || cfg.primaryUrl === url);
});

test('résolution : rentry -> address.json de l’hôte annoncé, cache écrit', async () => {
  const { fetchImpl, calls } = fakeFetch({
    'https://rentry.co/movix': { body: '<article><a href="https://movix.example/">m</a></article>' },
    'https://movix.example/address.json': { body: JSON.stringify(ADDRESS_JSON) },
  });
  let cached = null;
  const cfg = await resolveAddressConfig({ fetchImpl, writeCache: (v) => { cached = v; } });
  assert.equal(cfg.source, 'address.json@movix.example');
  assert.equal(cfg.primaryUrl, 'https://movix.luxe');
  assert.equal(cached.primaryUrl, 'https://movix.luxe');
  assert.equal(calls.length, 2);
});

test('résolution : rentry en panne -> résolveur connu', async () => {
  const { fetchImpl } = fakeFetch({
    'https://rentry.co/movix': new Error('ECONNRESET'),
    'https://movix.online/address.json': { body: JSON.stringify(ADDRESS_JSON) },
  });
  const cfg = await resolveAddressConfig({ fetchImpl });
  assert.equal(cfg.source, 'address.json@movix.online');
});

test('résolution : tout en panne -> cache, puis liste codée en dur', async () => {
  const { fetchImpl } = fakeFetch({ 'https://rentry.co/movix': { status: 503, body: '' } });
  const fromCache = await resolveAddressConfig({
    fetchImpl,
    readCache: () => ({ primaryUrl: 'https://movix.cached', mirrors: [], githubUrl: 'g', telegramUrl: 't' }),
  });
  assert.equal(fromCache.source, 'cache');
  assert.equal(fromCache.primaryUrl, 'https://movix.cached');
  assert.ok(fromCache.mirrors.includes('https://movix.luxe'));

  const fallback = await resolveAddressConfig({ fetchImpl, readCache: () => null });
  assert.equal(fallback.source, 'fallback');
  assert.equal(fallback.primaryUrl, FALLBACK_CONFIG.PRIMARY_URL);
});
