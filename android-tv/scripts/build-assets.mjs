// Génère les fichiers embarqués par l'appli Android TV à partir des sources
// partagées avec l'appli de bureau (desktop/src, userscript/) : une seule
// interface télé, un seul pont « extension », une seule liste de régies et de
// miroirs à maintenir.
//
//   app/src/main/assets/inject-site.js   pages du site : interface télé, pont GM, userscript
//   app/src/main/assets/inject-frame.js  tous les cadres : relais des touches vers la vidéo
//   app/src/main/assets/adhosts.txt      domaines de régies bloqués (un par ligne)
//   app/src/main/assets/mirrors.txt      adresses du site, dans l'ordre d'essai (une par ligne)
//
// Usage : node android-tv/scripts/build-assets.mjs
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const desktop = join(root, 'desktop', 'src');
const assets = join(here, '..', 'app', 'src', 'main', 'assets');

const BRAND = require(join(desktop, 'branding.js'));
const { buildInjectedJavaScript } = require(join(desktop, 'injection', 'bridge-runtime.js'));
const { pickNext, controlVideo } = require(join(desktop, 'lib', 'tvNav.js'));
const { BUILTIN_AD_DOMAINS } = require(join(desktop, 'lib', 'adBlock.js'));
const { FALLBACK_CONFIG } = require(join(desktop, 'lib', 'addressResolver.js'));

const version = /versionName\s+"([^"]+)"/.exec(readFileSync(join(here, '..', 'app', 'build.gradle'), 'utf8'))[1];
const homePath = /HOME_PATH",\s*'"([^"]+)"'/.exec(readFileSync(join(here, '..', 'app', 'build.gradle'), 'utf8'))[1];
const tvApp = readFileSync(join(desktop, 'injection', 'tv-app.js'), 'utf8');
const themeCss = readFileSync(join(desktop, 'injection', 'theme.css'), 'utf8');
const icon = `data:image/png;base64,${readFileSync(join(desktop, 'injection', 'brand-icon.png')).toString('base64')}`;
// Même préparation que desktop/scripts/sync-userscript.mjs : sans l'en-tête Tampermonkey.
const userscriptSource = readFileSync(join(root, 'userscript', 'movix.user.js'), 'utf8')
  .replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/, '');

// Régie de la page des chaînes en direct, absente de la liste intégrée (l'appli
// de bureau la bloque par ses listes de filtres, que le WebView n'a pas).
const EXTRA_AD_HOSTS = ['musikazblai.org'];

const tvConfig = {
  appName: BRAND.APP_NAME,
  accent: BRAND.ACCENT,
  tmdbKey: process.env.MOVIX_TMDB_KEY || BRAND.TMDB_PUBLIC_KEY,
  icon,
  phoneRemote: false,   // la télécommande de la télé suffit
  standalone: true,     // pas de « mode normal » où revenir : quitter = fermer l'appli
  // L'interface télé vit sur une page légère du site (même origine, donc mêmes
  // réglages et même reprise de lecture) : le site complet ne se charge que pour lire.
  homePath,
};

// Pont GM + retouches du site + userscript : exactement ceux du bureau.
// SwiftFlux est coupé : sa vérification « robot » est infaisable à la télécommande.
const extension = buildInjectedJavaScript({
  version,
  userscriptSource,
  appName: BRAND.APP_NAME,
  accent: BRAND.ACCENT,
  hideSiteBranding: true,
  localVip: true,
  swiftfluxSource: 'off',
  themeCss,
  brandIconUrl: icon,
});

const frameScript = `/* MEWFLIX Android TV ${version} — généré par android-tv/scripts/build-assets.mjs, ne pas modifier. */
(function () {
  'use strict';
  // Cadre d'un lecteur externe (chaînes en direct, lecteur de secours) : la page
  // du dessus relaie les touches de la télécommande, la vidéo est pilotée ici.
  if (window.top === window || window.__MEWFLIX_ANDROID_FRAME__) return;
  window.__MEWFLIX_ANDROID_FRAME__ = true;
  var controlVideo = ${controlVideo.toString()};
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (event.source !== window.parent || !data || typeof data.mewflixTvKey !== 'string') return;
    var label = '';
    try { label = controlVideo(document, data.mewflixTvKey); } catch (e) { label = ''; }
    if (label) {
      try { window.top.postMessage({ mewflixTvLabel: label, id: data.id }, '*'); } catch (e) { /* cadre détaché */ }
      return;
    }
    var inner = document.querySelectorAll('iframe');
    for (var i = 0; i < inner.length; i++) {
      try { inner[i].contentWindow.postMessage(data, '*'); } catch (e) { /* cadre pas prêt */ }
    }
  });
})();
`;

const siteScript = `/* MEWFLIX Android TV ${version} — généré par android-tv/scripts/build-assets.mjs, ne pas modifier. */
(function () {
  'use strict';
  if (window.top !== window || window.__MEWFLIX_ANDROID__) return;
  if (!/(^|\\.)movix\\.[a-z]{2,12}$/.test(location.hostname)) return;
  window.__MEWFLIX_ANDROID__ = true;

  // --- Pont natif (rôle du preload sur le bureau) ------------------------------
  // MewflixNative n'existe que dans le cadre principal des pages du site. Les
  // requêtes du userscript y partent en JSON ; la réponse revient par onmessage.
  var nativePort = window.MewflixNative || null;
  var waiting = {};
  var sequence = 0;
  if (nativePort) {
    nativePort.onmessage = function (event) {
      var data;
      try { data = JSON.parse(event.data); } catch (e) { return; }
      var resolve = data && waiting[data.reqId];
      if (!resolve) return;
      delete waiting[data.reqId];
      resolve(data.result);
    };
  }
  function callNative(type, payload) {
    if (!nativePort) return Promise.resolve({ success: false, error: 'Pont natif indisponible' });
    return new Promise(function (resolve) {
      var reqId = 'r' + (++sequence);
      waiting[reqId] = resolve;
      nativePort.postMessage(JSON.stringify({ reqId: reqId, type: type, payload: payload }));
    });
  }
  function isSiteUrl(url) {
    try { return /(^|\\.)movix\\.[a-z]{2,12}$/.test(new URL(String(url), location.href).hostname); } catch (e) { return false; }
  }
  // Fermer l'appli : drapeau lu par l'activité dans la valeur renvoyée par
  // __mewflixAndroidKey (l'appli n'offre aucune commande à la page).
  var exitAsked = false;
  function quit() { exitAsked = true; return Promise.resolve(); }
  window.__movixDesktop = {
    version: ${JSON.stringify(version)},
    platform: 'android-tv',
    gmFetch: function (message) { return callNative('fetch', message); },
    gmAbort: function (id) { return callNative('abort', String(id)); },
    isAdBlockEnabled: function () { return true; },
    // Pas de navigateur où envoyer un lien sur une télé : tout ce qui sort du site est ignoré.
    isAllowedInApp: isSiteUrl,
    classifyUrl: function (url) { return isSiteUrl(url) ? 'app' : 'blocked'; },
    openExternal: function () { return Promise.resolve(false); },
    reportBlockedPopup: function () {},
    tv: {
      info: function () { return Promise.resolve({ version: ${JSON.stringify(version)}, autoStart: false, remoteUrl: '', qr: '' }); },
      setAutoStart: function () { return Promise.resolve(false); },
      exit: quit,
      quit: quit,
    },
  };
  window.__MEWFLIX_TV_CONFIG__ = ${JSON.stringify(tvConfig)};
  window.__mewflixPickNext = ${pickNext.toString()};
  window.__mewflixControlVideo = ${controlVideo.toString()};

  // --- Touches -------------------------------------------------------------------
  // Appelé par l'activité Android pour chaque appui. Valeurs renvoyées : 'done',
  // 'exit' (fermer l'appli), 'tap' (toucher le centre de l'écran : lecteur qui
  // attend un appui), 'wait' (question posée aux cadres, rappeler
  // __mewflixAndroidPoll), 'no-tv' (interface absente).
  var frameAsk = 0;
  var frameLabel = '';
  var pendingKey = '';
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (data && typeof data.mewflixTvLabel === 'string' && data.id === frameAsk) frameLabel = data.mewflixTvLabel;
  });
  function fallback(key) {
    var result = 'none';
    try { if (window.__mewflixTvFallback) result = window.__mewflixTvFallback(key); } catch (e) { result = 'none'; }
    return result === 'none' && (key === 'ok' || key === 'playpause') ? 'tap' : 'done';
  }
  window.__mewflixAndroidKey = function (key) {
    var result = 'no-tv';
    try { if (window.__mewflixTvKey) result = window.__mewflixTvKey(key); } catch (e) { result = 'done'; }
    if (exitAsked) { exitAsked = false; return 'exit'; }
    if (result === 'no-tv') return 'no-tv';
    if (result !== 'no-video') return 'done';
    var frames = document.querySelectorAll('iframe');
    if (!frames.length) return fallback(key);
    frameAsk += 1;
    frameLabel = '';
    pendingKey = key;
    for (var i = 0; i < frames.length; i++) {
      try { frames[i].contentWindow.postMessage({ mewflixTvKey: key, id: frameAsk }, '*'); } catch (e) { /* cadre pas prêt */ }
    }
    return 'wait';
  };
  window.__mewflixAndroidPoll = function () {
    var key = pendingKey;
    pendingKey = '';
    if (frameLabel) {
      if (window.__mewflixTvHud) window.__mewflixTvHud(frameLabel);
      frameLabel = '';
      return 'done';
    }
    return key ? fallback(key) : 'done';
  };
  // Dernière erreur de script de la page, pour les diagnostics des builds de test.
  var lastError = '';
  window.addEventListener('error', function (event) {
    lastError = String((event && event.message) || '').slice(0, 200) + ' @' + String((event && event.lineno) || '');
  });
  window.__mewflixAndroidError = function (text) { lastError = String(text).slice(0, 300); };
  // État lu par l'activité : écran d'attente à retirer, diagnostics des builds de test.
  window.__mewflixAndroidState = function () {
    var active = document.activeElement;
    var cursor = document.querySelector('#mewflix-tv .tv-on');
    var videos = Array.prototype.map.call(document.querySelectorAll('video'), function (v) {
      return { ready: v.readyState, paused: v.paused, t: Math.round(v.currentTime), w: v.videoWidth };
    });
    return JSON.stringify({
      path: location.pathname,
      ready: Boolean(document.getElementById('mewflix-tv')) || location.pathname.indexOf('/watch/') === 0,
      bridge: Boolean(nativePort),
      tv: Boolean(window.__MEWFLIX_TV_ACTIVE__),
      doc: document.contentType + ' ' + document.readyState + ' body=' + (document.body ? Array.prototype.map.call(document.body.children, function (n) { return n.tagName + (n.id ? '#' + n.id : ''); }).join(',') : 'null')
        + ' htmlClass=' + (document.documentElement ? document.documentElement.className : 'null'),
      error: lastError,
      extension: Boolean(window.__MOVIX_DESKTOP_USERSCRIPT_DONE),
      cursor: cursor ? (cursor.getAttribute('data-fk') || '') : '',
      focus: active && active.tagName ? active.tagName : '',
      focusables: document.querySelectorAll('#mewflix-tv [data-f]').length,
      heading: (document.querySelector('#mewflix-tv h1') || {}).textContent || '',
      layer: (document.querySelector('#mewflix-tv .tv-layer, #mewflix-tv .tv-live') || {}).className || '',
      videos: videos,
      player: window.__mewflixTvPlayerState ? window.__mewflixTvPlayerState() : null,
      frames: document.querySelectorAll('iframe').length,
    });
  };
})();
if (window.__MEWFLIX_ANDROID__ && !window.__MEWFLIX_TV_ACTIVE__) {
try {
${tvApp}
} catch (e) {
  // Interface télé indisponible : le site reste affiché.
  if (window.__mewflixAndroidError) window.__mewflixAndroidError('tv: ' + (e && (e.stack || e.message) || e));
}
}
${extension}
`;

// Contrôle de syntaxe des scripts assemblés (compilés ici, jamais exécutés) :
// ils ne contiennent que du code de ce dépôt, aucune donnée extérieure.
new Function(frameScript);
new Function(siteScript);

const adHosts = [...new Set([...BUILTIN_AD_DOMAINS, ...EXTRA_AD_HOSTS]
  .map((entry) => String(entry).toLowerCase().split('/')[0])
  .filter((host) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)))].sort();
const mirrors = [FALLBACK_CONFIG.PRIMARY_URL, ...FALLBACK_CONFIG.MIRRORS];

mkdirSync(assets, { recursive: true });
writeFileSync(join(assets, 'inject-site.js'), siteScript, 'utf8');
writeFileSync(join(assets, 'inject-frame.js'), frameScript, 'utf8');
writeFileSync(join(assets, 'adhosts.txt'), `${adHosts.join('\n')}\n`, 'utf8');
writeFileSync(join(assets, 'mirrors.txt'), `${mirrors.join('\n')}\n`, 'utf8');
process.stdout.write(`[assets] site ${(siteScript.length / 1024).toFixed(0)} Ko, cadres ${(frameScript.length / 1024).toFixed(1)} Ko, ${adHosts.length} régies, ${mirrors.length} miroirs, version ${version}\n`);
