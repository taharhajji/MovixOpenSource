import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildSiteTweaks, DEFAULT_TOP_LEVEL_ORDER } = require('../src/injection/site-tweaks.js');
const { buildInjectedJavaScript } = require('../src/injection/bridge-runtime.js');

/** Exécute le code des retouches dans un faux navigateur minimal. */
function runInFakePage(code, { storage = {}, extraGlobals = {} } = {}) {
  const store = new Map(Object.entries(storage));
  class Storage {
    getItem(k) { return store.has(k) ? store.get(k) : null; }
    setItem(k, v) { store.set(k, String(v)); }
    removeItem(k) { store.delete(k); }
    get length() { return store.size; }
    key(i) { return [...store.keys()][i] ?? null; }
  }
  const localStorage = new Storage();
  const document = {
    documentElement: null,
    head: null,
    getElementById: () => null,
    createElement: () => ({ style: {} }),
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  const window = { localStorage, document, addEventListener: () => {} };
  const sandbox = { window, document, localStorage, Storage, console, Date, JSON, Math, ...extraGlobals };
  const fn = new Function(...Object.keys(sandbox), code);
  fn(...Object.values(sandbox));
  return { store, window };
}

test('toutes les combinaisons produisent du JS valide', () => {
  for (const localVip of [true, false]) for (const hideSiteBranding of [true, false]) for (const swiftfluxSource of ['last', 'off', 'keep']) {
    const code = buildSiteTweaks({ appName: 'X', localVip, hideSiteBranding, adPopupAutoExpr: 'true', swiftfluxSource });
    assert.doesNotThrow(() => new Function(code));
  }
  assert.doesNotThrow(() => new Function(buildInjectedJavaScript({ version: '1', userscriptSource: '1;', appName: 'X', swiftfluxSource: 'last' })));
});

test('SwiftFlux relégué en dernier à partir des réglages par défaut, désactivé en mode off', () => {
  const { store } = runInFakePage(buildSiteTweaks({ appName: 'X', swiftfluxSource: 'last' }));
  const prefs = JSON.parse(store.get('settings_source_priority_prefs'));
  const order = prefs.categories.moviesTv.sourceOrder;
  assert.equal(prefs.version, 4);
  assert.equal(order.length, DEFAULT_TOP_LEVEL_ORDER.length);
  assert.deepEqual(order[order.length - 1], { id: 'swiftflux', enabled: true });
  assert.equal(order[0].id, 'nexus_hls');

  const off = runInFakePage(buildSiteTweaks({ appName: 'X', swiftfluxSource: 'off' }));
  const offOrder = JSON.parse(off.store.get('settings_source_priority_prefs')).categories.moviesTv.sourceOrder;
  assert.deepEqual(offOrder[offOrder.length - 1], { id: 'swiftflux', enabled: false });
});

test('SwiftFlux : réglages existants respectés, pin retiré, dernier lecteur oublié, idempotent', () => {
  const existing = {
    version: 4,
    categories: {
      moviesTv: {
        sourceOrder: [{ id: 'swiftflux', enabled: true }, { id: 'darkino', enabled: false }, { id: 'mp4', enabled: true }],
        hosterOrder: ['uqload'], languageOrder: [], overrides: {}, pinnedSource: { id: 'swiftflux', snapshot: [] }, pinnedHoster: null, pinnedLanguage: null,
      },
      anime: { languageOrder: [], hosterOrder: [], overrides: {}, pinnedLanguage: null, pinnedHoster: null },
    },
    customHosters: [{ id: 'custom_x', name: 'x', patterns: [] }], patternOverrides: {}, updatedAt: 1,
  };
  const { store } = runInFakePage(buildSiteTweaks({ appName: 'X', swiftfluxSource: 'last' }), {
    storage: { settings_source_priority_prefs: JSON.stringify(existing), playerLastId: 'swiftflux' },
  });
  const prefs = JSON.parse(store.get('settings_source_priority_prefs'));
  assert.deepEqual(prefs.categories.moviesTv.sourceOrder.map((e) => e.id), ['darkino', 'mp4', 'swiftflux']);
  assert.equal(prefs.categories.moviesTv.sourceOrder[0].enabled, false, 'les autres réglages sont conservés');
  assert.equal(prefs.categories.moviesTv.pinnedSource, null);
  assert.equal(prefs.customHosters.length, 1);
  assert.equal(store.has('playerLastId'), false);

  const before = store.get('settings_source_priority_prefs');
  runInFakePage(buildSiteTweaks({ appName: 'X', swiftfluxSource: 'last' }), { storage: Object.fromEntries(store) });
  assert.equal(store.get('settings_source_priority_prefs'), before, 'rien n’est réécrit quand c’est déjà en place');
});

test('un ancien schéma de réglages est laissé intact (le site le migre)', () => {
  const legacy = JSON.stringify({ version: 3, categories: { moviesTv: { sourceOrder: [] }, anime: { languageOrder: [] } } });
  const { store } = runInFakePage(buildSiteTweaks({ appName: 'X', swiftfluxSource: 'last' }), { storage: { settings_source_priority_prefs: legacy } });
  assert.equal(store.get('settings_source_priority_prefs'), legacy);
});

test('popup pub : mode auto forcé et restauré selon l’expression', () => {
  const on = runInFakePage(buildSiteTweaks({ appName: 'X', adPopupAutoExpr: 'true', storagePrefix: 'p' }), { storage: { settings_ad_popup_mode: 'click-anywhere' } });
  assert.equal(on.store.get('settings_ad_popup_mode'), 'auto');
  assert.equal(on.store.get('p:ad_popup_forced'), 'click-anywhere');
  const off = runInFakePage(buildSiteTweaks({ appName: 'X', adPopupAutoExpr: 'false', storagePrefix: 'p' }), { storage: Object.fromEntries(on.store) });
  assert.equal(off.store.get('settings_ad_popup_mode'), 'click-anywhere');
  assert.equal(off.store.has('p:ad_popup_forced'), false);
});

test('popups externes neutralisés (web) : hôtes sûrs et même origine passent, le reste reçoit une fenêtre factice', () => {
  const opened = [];
  const code = buildSiteTweaks({ appName: 'X', popupSafeHosts: ['t.me', 'github.com'] });
  const { window } = runInFakePage(code, { extraGlobals: { location: { href: 'https://mewflix-app.vercel.app/', origin: 'https://mewflix-app.vercel.app' }, URL } });
  // runInFakePage n'expose pas window.open : on rejoue le bloc sur un faux window.
  const fakeWin = { open: (u) => { opened.push(u); return { real: true }; }, localStorage: window.localStorage, document: window.document, addEventListener() {} };
  const fn = new Function('window', 'location', 'URL', 'Storage', 'localStorage', 'document', 'console', 'Date', 'JSON', 'Math', code);
  fn(fakeWin, { href: 'https://mewflix-app.vercel.app/', origin: 'https://mewflix-app.vercel.app' }, URL, class {}, window.localStorage, window.document, console, Date, JSON, Math);
  assert.equal(fakeWin.open('https://ads.example/go').real, undefined, 'régie : fenêtre factice');
  assert.equal(fakeWin.open('https://t.me/movix_site').real, true, 'hôte sûr : ouverture réelle');
  assert.equal(fakeWin.open('/film/1').real, true, 'même origine : ouverture réelle');
  assert.deepEqual(opened, ['https://t.me/movix_site', '/film/1']);
});

test('VIP local : la clé is_vip est épinglée à true', () => {
  const { window } = runInFakePage(buildSiteTweaks({ appName: 'X', localVip: true }));
  window.localStorage.removeItem('is_vip');
  window.localStorage.setItem('is_vip', 'false');
  assert.equal(window.localStorage.getItem('is_vip'), 'true');
  assert.equal(window.__ORBIT_LOCAL_VIP__, true);
});
