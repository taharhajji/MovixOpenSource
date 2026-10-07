import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { isAllowedInApp, isMovixHost, isSiteHost } = require('../src/lib/navigationPolicy.js');
const { AppConfig, readSiteOverride, normalizeSiteUrl, readSiteBrandingOverride } = require('../src/lib/config.js');

test('statut VIP local actif par défaut, --local-vip=off et MOVIX_LOCAL_VIP=0 le coupent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'movix-vip-'));
  try {
    assert.equal(new AppConfig(dir).localVipEnabled, true);
    assert.equal(new AppConfig(dir, { argv: ['--local-vip=off'] }).localVipEnabled, false);
    assert.equal(new AppConfig(dir, { env: { MOVIX_LOCAL_VIP: '0' } }).localVipEnabled, false);
    new AppConfig(dir).set('localVip', false);
    assert.equal(new AppConfig(dir).localVipEnabled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('marque du site masquée par défaut, réaffichable par --site-branding=on ou MOVIX_SITE_BRANDING=1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'movix-brand-'));
  try {
    assert.equal(new AppConfig(dir).hideSiteBranding, true);
    assert.equal(new AppConfig(dir, { argv: ['--site-branding=on'] }).hideSiteBranding, false);
    assert.equal(new AppConfig(dir, { env: { MOVIX_SITE_BRANDING: '1' } }).hideSiteBranding, false);
    assert.equal(new AppConfig(dir, { env: { MOVIX_SITE_BRANDING: 'off' } }).hideSiteBranding, true);
    new AppConfig(dir).set('hideSiteBranding', false);
    assert.equal(new AppConfig(dir).hideSiteBranding, false);
    assert.equal(readSiteBrandingOverride([], {}), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
