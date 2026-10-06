import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { isAllowedInApp, isMovixHost, isSiteHost } = require('../src/lib/navigationPolicy.js');
const { AppConfig, readSiteOverride, normalizeSiteUrl } = require('../src/lib/config.js');

test('domaines Movix et hôtes locaux', () => {
  assert.equal(isMovixHost('movix.luxe'), true);
  assert.equal(isMovixHost('www.movix.college'), true);
  assert.equal(isMovixHost('localhost'), true);
  assert.equal(isMovixHost('notmovix.com'), false);
  assert.equal(isMovixHost('movix.com.evil.io'), false);
});

test('navigation dans l’app : site, hôte imposé, OAuth ; externe sinon', () => {
  assert.equal(isAllowedInApp('https://movix.fun/film/1'), true);
  assert.equal(isAllowedInApp('https://discord.com/oauth2/authorize?x'), true);
  assert.equal(isAllowedInApp('https://accounts.google.com/o/oauth2/v2/auth'), true);
  assert.equal(isAllowedInApp('https://t.me/movix_site'), false);
  assert.equal(isAllowedInApp('https://ads.example/smartlink'), false);
  assert.equal(isAllowedInApp('javascript:alert(1)'), false);
  assert.equal(isAllowedInApp('https://staging.internal:8443/', ['staging.internal']), true);
  assert.equal(isSiteHost('staging.internal', ['STAGING.internal']), true);
});

test('surcharge du site : --site puis MOVIX_SITE_URL, URL normalisée', () => {
  assert.equal(readSiteOverride(['--site=http://localhost:3000/'], {}), 'http://localhost:3000');
  assert.equal(readSiteOverride([], { MOVIX_SITE_URL: 'https://staging.movix.dev' }), 'https://staging.movix.dev');
  assert.equal(readSiteOverride(['--site=ftp://x'], {}), '');
  assert.equal(normalizeSiteUrl('  https://a.b/// '), 'https://a.b');
});

test('AppConfig lit, écrit et priorise la ligne de commande', () => {
  const dir = mkdtempSync(join(tmpdir(), 'movix-desktop-'));
  try {
    const first = new AppConfig(dir);
    assert.equal(first.forcedSiteUrl, '');
    first.set('siteUrl', 'https://movix.men');
    first.set('lastMirror', 'https://movix.fun');
    const written = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    assert.equal(written.lastMirror, 'https://movix.fun');

    const second = new AppConfig(dir, { argv: ['--site=http://127.0.0.1:5173'] });
    assert.equal(second.get('siteUrl'), 'https://movix.men');
    assert.equal(second.forcedSiteUrl, 'http://127.0.0.1:5173');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
