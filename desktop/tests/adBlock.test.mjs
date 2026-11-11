import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { AdBlocker, isBuiltinAdUrl, isNeverBlockedHost } = require('../src/lib/adBlock.js');
const { classifyExternalUrl, isSafeExternalHost } = require('../src/lib/navigationPolicy.js');
const { AppConfig, readAdBlockOverride } = require('../src/lib/config.js');

const isSiteHost = (h) => /(?:^|\.)movix\.[a-z]+$/.test(h) || h === 'localhost';

test('liste intégrée : régies, sous-domaines, entrées hôte/chemin', () => {
  assert.equal(isBuiltinAdUrl('https://ad.doubleclick.net/x'), true);
  assert.equal(isBuiltinAdUrl('https://cdn.popads.net/pop.js'), true);
  assert.equal(isBuiltinAdUrl('https://www.google-analytics.com/analytics.js'), true);
  assert.equal(isBuiltinAdUrl('https://an.yandex.ru/system/context.js'), true);
  assert.equal(isBuiltinAdUrl('https://movix.luxe/assets/index.js'), false);
  assert.equal(isBuiltinAdUrl('https://notpopads.net/'), false, 'suffixe strict, pas de sous-chaîne');
  assert.equal(isNeverBlockedHost('api.themoviedb.org'), true);
});

test('shouldBlock : désactivé = jamais, site et hôtes protégés = jamais, régie = oui', () => {
  const blocker = new AdBlocker({ cacheDir: tmpdir(), isSiteHost, log: { log() {}, warn() {} } });
  blocker.enabled = false;
  assert.equal(blocker.shouldBlock({ url: 'https://ad.doubleclick.net/x', resourceType: 'script' }), false);
  blocker.enabled = true;
  assert.equal(blocker.shouldBlock({ url: 'https://ad.doubleclick.net/x', resourceType: 'script' }), true);
  assert.equal(blocker.shouldBlock({ url: 'https://movix.luxe/api/x', resourceType: 'xhr' }), false);
  assert.equal(blocker.shouldBlock({ url: 'https://api.themoviedb.org/3/movie/1', resourceType: 'xhr' }), false);
  assert.equal(blocker.shouldBlock({ url: 'https://challenges.cloudflare.com/turnstile/v0/api.js', resourceType: 'script' }), false);
  assert.equal(blocker.summary().requests, 1);
});

test('shouldBlock : jamais les flux média, les WebSockets, les hébergeurs vidéo ni les requêtes du principal', () => {
  const blocker = new AdBlocker({ cacheDir: tmpdir(), isSiteHost, log: { log() {}, warn() {} } });
  blocker.engine = { match: () => ({ match: true }) };
  assert.equal(blocker.shouldBlock({ url: 'https://cdn.anything.example/seg.ts', resourceType: 'media' }), false);
  assert.equal(blocker.shouldBlock({ url: 'wss://anything.example/socket', resourceType: 'webSocket' }), false);
  assert.equal(blocker.shouldBlock({ url: 'https://vidzy.org/e/abc', resourceType: 'subFrame' }), false, 'hébergeur vidéo connu');
  assert.equal(blocker.shouldBlock({ url: 'https://ad.doubleclick.net/x', resourceType: 'script', fromMainProcess: true }), false, 'GM_xmlhttpRequest');
  assert.equal(blocker.shouldBlock({ url: 'https://ad.doubleclick.net/x', resourceType: 'script' }), true);
});

test('shouldBlock : le moteur de filtres est consulté avec le type Electron et le referrer', () => {
  const blocker = new AdBlocker({ cacheDir: tmpdir(), isSiteHost, log: { log() {}, warn() {} } });
  const seen = [];
  blocker.engine = {
    match(request) {
      // Le referrer n'est gardé que haché (sourceHostnameHashes) ; il suffit à
      // qualifier la requête de tierce partie, ce que les filtres `$third-party` lisent.
      seen.push({ url: request.url, type: request.type, thirdParty: request.isThirdParty });
      return { match: request.url.includes('/ads/') };
    },
  };
  assert.equal(blocker.shouldBlock({ url: 'https://cdn.example.com/ads/banner.js', resourceType: 'script', referrer: 'https://movix.luxe/' }), true);
  assert.equal(blocker.shouldBlock({ url: 'https://cdn.example.com/player.js', resourceType: 'script', referrer: 'https://movix.luxe/' }), false);
  assert.equal(seen[0].type, 'script');
  assert.equal(seen[0].thirdParty, true);
  assert.equal(blocker.summary().top[0], 'cdn.example.com (1)');
});

test('load : moteur injecté, puis repli sur la liste intégrée si le moteur échoue', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'movix-adblock-'));
  try {
    const ok = new AdBlocker({ cacheDir: dir, isSiteHost, log: { log() {}, warn() {} } });
    const info = await ok.load(async () => { throw new Error('pas de réseau'); }, { engineFactory: async () => ({ match: () => ({ match: false }) }) });
    assert.deepEqual(info, { engine: true, source: 'réseau' });

    const ko = new AdBlocker({ cacheDir: dir, isSiteHost, log: { log() {}, warn() {} } });
    const infoKo = await ko.load(async () => { throw new Error('x'); }, { engineFactory: async () => { throw new Error('listes injoignables'); } });
    assert.deepEqual(infoKo, { engine: false, source: 'indisponible' });
    assert.equal(ko.shouldBlock({ url: 'https://static.adsterra.com/x.js', resourceType: 'script' }), true, 'liste intégrée toujours active');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('popups : hôtes sûrs ouverts, le reste neutralisé quand le blocage est actif', () => {
  assert.equal(isSafeExternalHost('t.me'), true);
  assert.equal(isSafeExternalHost('www.github.com'), true);
  assert.equal(isSafeExternalHost('smartlink.ads.example'), false);
  assert.equal(classifyExternalUrl('https://movix.fun/x'), 'app');
  assert.equal(classifyExternalUrl('https://t.me/movix_site', { adBlockEnabled: true }), 'external');
  assert.equal(classifyExternalUrl('https://smartlink.ads.example/go', { adBlockEnabled: true }), 'blocked');
  assert.equal(classifyExternalUrl('https://smartlink.ads.example/go', { adBlockEnabled: false }), 'external');
  assert.equal(classifyExternalUrl('mailto:x@y.z', { adBlockEnabled: true }), 'external');
});

test('config : blocage actif par défaut, --adblock=off et MOVIX_ADBLOCK=0 le coupent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'movix-adblock-cfg-'));
  try {
    assert.equal(new AppConfig(dir).adBlockEnabled, true);
    assert.equal(new AppConfig(dir, { argv: ['--adblock=off'] }).adBlockEnabled, false);
    assert.equal(new AppConfig(dir, { env: { MOVIX_ADBLOCK: '0' } }).adBlockEnabled, false);
    assert.equal(new AppConfig(dir, { argv: ['--adblock=on'], env: { MOVIX_ADBLOCK: '0' } }).adBlockEnabled, true, 'la ligne de commande prime');
    const cfg = new AppConfig(dir);
    cfg.set('adBlock', false);
    assert.equal(new AppConfig(dir).adBlockEnabled, false);
    assert.equal(readAdBlockOverride(['--adblock=peut-être'], {}), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mode strict des lecteurs externes : tiers inconnus bloqués, lecteur, vidéo et bibliothèques autorisés', () => {
  const { siteOf } = require('../src/lib/adBlock.js');
  assert.equal(siteOf('u14.vidzy.org'), 'vidzy.org');
  assert.equal(siteOf('a.b.example.co.uk'), 'example.co.uk');
  assert.equal(siteOf('93.123.109.95'), '93.123.109.95');

  const blocker = new AdBlocker({ cacheDir: tmpdir(), isSiteHost: (h) => h === 'movix.luxe', log: { log() {}, warn() {} } });
  const ctx = { requesterHost: 'vidzy.org', rootHost: 'vidzy.org' };
  const check = (url, resourceType, context = ctx) => blocker.shouldBlockEmbedRequest({ url, resourceType, ...context });

  // Régies à domaines jetables : scripts, sous-cadres et appels de données bloqués.
  assert.equal(check('https://is.sapelemoils.click/a.js', 'script'), true);
  assert.equal(check('https://reoils.tampanslimpetjab.cfd/x', 'xhr'), true);
  assert.equal(check('https://ehiakjopnzwcc.online/track', 'xhr'), true);
  assert.equal(check('https://ads.example.net/frame.html', 'subFrame'), true);
  // Le lecteur lui-même, ses sous-domaines et le site.
  assert.equal(check('https://vidzy.org/js/player.js', 'script'), false);
  assert.equal(check('https://u14.vidzy.org/hls/x', 'xhr'), false);
  assert.equal(check('https://movix.luxe/api/x', 'xhr'), false);
  // Bibliothèques connues.
  assert.equal(check('https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js', 'script'), false);
  assert.equal(check('https://ssl.p.jwpcdn.com/player/v/8/jwplayer.js', 'script'), false);
  // Vidéo : playlist sur un CDN inconnu, puis segments sans extension du même site.
  assert.equal(check('https://cdn7.randomcdn.xyz/v/abc/seg', 'xhr'), true);
  assert.equal(check('https://cdn7.randomcdn.xyz/v/abc/master.m3u8', 'xhr'), false);
  assert.equal(check('https://cdn7.randomcdn.xyz/v/abc/seg', 'xhr'), false);
  assert.equal(check('https://other.cdn.io/v/seg-001.ts', 'xhr'), false);
  // Types jamais bloqués, images et styles laissés aux listes.
  assert.equal(check('https://ads.example.net/video.mp4', 'media'), false);
  assert.equal(check('https://ads.example.net/banner.png', 'image'), false);
  // Cadre publicitaire imbriqué dans le lecteur : même règle.
  assert.equal(check('https://tracker.bad.top/t.js', 'script', { requesterHost: 'ads.example.net', rootHost: 'vidzy.org' }), true);
  // Désactivable.
  blocker.strictEmbeds = false;
  assert.equal(check('https://is.sapelemoils.click/a.js', 'script'), false);
  blocker.strictEmbeds = true;
  blocker.enabled = false;
  assert.equal(check('https://is.sapelemoils.click/a.js', 'script'), false);
});

test('config : mode strict des lecteurs externes actif par défaut, surchargeable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mewflix-cfg-'));
  try {
    assert.equal(new AppConfig(dir).strictEmbedsEnabled, true);
    assert.equal(new AppConfig(dir, { argv: ['--strict-embeds=off'] }).strictEmbedsEnabled, false);
    assert.equal(new AppConfig(dir, { env: { MOVIX_STRICT_EMBEDS: '0' } }).strictEmbedsEnabled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
