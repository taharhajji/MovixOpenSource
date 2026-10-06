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
