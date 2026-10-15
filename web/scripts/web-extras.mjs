/**
 * Extras de la version web MEWFLIX, injectés en fin de <body> (après le
 * script de retouches partagé avec l'app de bureau) :
 *
 *  - logo dans l'en-tête, à côté du nom ;
 *  - service worker (page hors-ligne, assets en cache) et mise à jour douce ;
 *  - bouton « Installer l'app » sur mobile (Android : invite native ;
 *    iPhone : explication « Partager → Sur l'écran d'accueil ») ;
 *  - bouton « Surprends-moi » sur l'accueil : un film ou une série au hasard
 *    parmi ce qui est affiché, lancé directement dans le lecteur ;
 *  - bouton « Remonter » discret sur les longues pages.
 *
 * Vanilla JS, aucun accès au code React du site : tout passe par le DOM.
 */

export function buildWebExtras({ appName, accent, accentSoft, background, iconUrl, build, embedIds = [], storagePrefix = 'mewflix_web' }) {
  return `
(function() {
  'use strict';
  var APP = ${JSON.stringify(String(appName))};
  var EMBED_IDS = ${JSON.stringify(embedIds)};
  var EMBED_MODE_KEY = ${JSON.stringify(`${storagePrefix}:embeds_mode`)};
  // Liste des hôtes exemptés et bascule du mode : fournies par les retouches partagées.
  var EMBED_API = window.__orbitEmbeds || null;
  var EMBED_EXEMPT = (EMBED_API && EMBED_API.exemptHosts) || ['challenges.cloudflare.com', 'youtube.com', 'youtube-nocookie.com', 'player.vimeo.com', 'accounts.google.com', 'discord.com'];
  var ACCENT = ${JSON.stringify(String(accent))};
  var ACCENT_SOFT = ${JSON.stringify(String(accentSoft))};
  var BG = ${JSON.stringify(String(background))};
  var ICON = ${JSON.stringify(String(iconUrl))};
  var BUILD = ${JSON.stringify(String(build))};
  var PREFIX = 'mewflix_web:';
  var isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  var isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  var isMobile = window.matchMedia('(max-width: 900px)').matches || /android|iphone|ipad|ipod/i.test(navigator.userAgent);

  function store(key, value) { try { if (value == null) localStorage.removeItem(PREFIX + key); else localStorage.setItem(PREFIX + key, String(value)); } catch (e) {} }
  function read(key) { try { return localStorage.getItem(PREFIX + key); } catch (e) { return null; } }

  // ---- Styles -------------------------------------------------------------
  var style = document.createElement('style');
  style.id = 'mewflix-web-extras-style';
  style.textContent = [
    '.mwx-fab { position: fixed; z-index: 60; right: max(16px, env(safe-area-inset-right)); bottom: calc(18px + env(safe-area-inset-bottom)); display: inline-flex; align-items: center; gap: .5em; padding: 12px 18px; border-radius: 999px; border: 0; cursor: pointer; font: 700 15px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: ' + BG + '; background: ' + ACCENT + '; box-shadow: 0 10px 30px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.08) inset; transition: transform .15s ease, opacity .25s ease; }',
    '.mwx-fab:hover { transform: translateY(-2px); } .mwx-fab:active { transform: scale(.97); }',
    '.mwx-fab[hidden] { display: none; }',
    '.mwx-fab .mwx-dice { font-size: 1.25em; line-height: 1; display: inline-block; }',
    '.mwx-fab.mwx-rolling .mwx-dice { animation: mwx-roll .7s ease-in-out infinite; }',
    '@keyframes mwx-roll { 0% { transform: rotate(0) } 50% { transform: rotate(180deg) scale(1.15) } 100% { transform: rotate(360deg) } }',
    '.mwx-top { position: fixed; z-index: 59; left: max(16px, env(safe-area-inset-left)); bottom: calc(18px + env(safe-area-inset-bottom)); width: 42px; height: 42px; border-radius: 50%; border: 1px solid rgba(255,255,255,.12); background: rgba(20,21,24,.82); color: ' + ACCENT + '; font-size: 20px; cursor: pointer; opacity: 0; pointer-events: none; transition: opacity .25s ease; backdrop-filter: blur(8px); }',
    '.mwx-top.mwx-show { opacity: 1; pointer-events: auto; }',
    '.mwx-install { position: fixed; z-index: 61; left: 12px; right: 12px; bottom: calc(12px + env(safe-area-inset-bottom)); display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 16px; background: rgba(20,21,24,.96); color: #e7edf7; border: 1px solid rgba(219,230,246,.18); box-shadow: 0 16px 40px rgba(0,0,0,.5); font: 14px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }',
    '.mwx-install img { width: 44px; height: 44px; border-radius: 12px; flex: none; }',
    '.mwx-install .mwx-text { flex: 1; min-width: 0; } .mwx-install b { display: block; font-size: 15px; } .mwx-install small { color: ' + ACCENT_SOFT + '; }',
    '.mwx-install button { border: 0; border-radius: 999px; padding: 10px 14px; font-weight: 700; cursor: pointer; background: ' + ACCENT + '; color: ' + BG + '; }',
    '.mwx-install .mwx-close { background: transparent; color: ' + ACCENT_SOFT + '; font-size: 20px; padding: 4px 8px; }',
    '.mwx-toast { position: fixed; z-index: 62; left: 50%; bottom: calc(80px + env(safe-area-inset-bottom)); transform: translateX(-50%); padding: 10px 16px; border-radius: 999px; background: rgba(20,21,24,.95); color: #e7edf7; border: 1px solid rgba(219,230,246,.18); font: 14px system-ui, sans-serif; box-shadow: 0 10px 30px rgba(0,0,0,.45); opacity: 0; transition: opacity .25s; pointer-events: none; }',
    '.mwx-toast.mwx-show { opacity: 1; }',
    '@media (max-width: 640px) { .mwx-fab { padding: 12px 14px; font-size: 14px; } .mwx-fab .mwx-label { display: none; } .mwx-fab .mwx-dice { font-size: 1.5em; } }',
    '.mwx-gate { position: absolute; inset: 0; z-index: 40; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 10px; padding: 24px; background: radial-gradient(circle at 50% 30%, rgba(88,107,147,.35), rgba(20,21,24,.98) 70%); color: #e7edf7; font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }',
    '.mwx-gate.mwx-fixed { position: fixed; z-index: 70; background: rgba(20,21,24,.97); }',
    '.mwx-gate img { width: 72px; height: 72px; border-radius: 18px; box-shadow: 0 12px 30px rgba(0,0,0,.5); }',
    '.mwx-gate h3 { margin: 6px 0 0; font-size: 1.25rem; } .mwx-gate p { margin: 0; max-width: 42ch; color: ' + ACCENT_SOFT + '; }',
    '.mwx-gate-actions { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; margin-top: 8px; }',
    '.mwx-gate button { border: 0; border-radius: 999px; padding: 11px 18px; font-weight: 700; cursor: pointer; font-size: 14px; }',
    '.mwx-gate-on { background: ' + ACCENT + '; color: ' + BG + '; } .mwx-gate-back { background: rgba(255,255,255,.1); color: #e7edf7; }',
    '.mwx-gate small { color: rgba(231,237,247,.55); }',
    '.mwx-embed-banner { position: fixed; z-index: 61; bottom: calc(14px + env(safe-area-inset-bottom)); left: 50%; transform: translateX(-50%); white-space: nowrap; display: flex; align-items: center; gap: 12px; padding: 8px 10px 8px 14px; border-radius: 999px; background: rgba(20,21,24,.92); color: #e7edf7; border: 1px solid rgba(219,230,246,.2); font: 13px system-ui, sans-serif; box-shadow: 0 10px 30px rgba(0,0,0,.45); max-width: calc(100vw - 24px); }',
    '.mwx-embed-banner button { border: 0; border-radius: 999px; padding: 6px 12px; font-weight: 700; cursor: pointer; background: ' + ACCENT + '; color: ' + BG + '; }',
  ].join('\\n');
  (document.head || document.documentElement).appendChild(style);

  function toast(message, ms) {
    var el = document.querySelector('.mwx-toast');
    if (!el) { el = document.createElement('div'); el.className = 'mwx-toast'; document.body.appendChild(el); }
    el.textContent = message;
    el.classList.add('mwx-show');
    clearTimeout(el._t);
    el._t = setTimeout(function() { el.classList.remove('mwx-show'); }, ms || 2600);
  }

  // ---- Logo dans l'en-tête (le nom est posé par les retouches partagées) ----
  // (Logo de l'en-tête : posé par les retouches partagées, option brandIconUrl.)

  // ---- Service worker ------------------------------------------------------
  // Le site enregistre lui-même /sw.js au chargement ; ici on ne fait
  // qu'écouter l'arrivée d'une nouvelle version.
  function registerSw() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
    navigator.serviceWorker.ready.then(function(reg) {
      // Nouvelle version prête : activée tout de suite, rechargement au prochain
      // changement de page (jamais pendant une lecture).
      reg.addEventListener('updatefound', function() {
        var worker = reg.installing;
        if (!worker) return;
        worker.addEventListener('statechange', function() {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            worker.postMessage('mewflix:skip-waiting');
            toast('Nouvelle version de ' + APP + ' prête');
          }
        });
      });
    }).catch(function() {});
  }

  // ---- Installation (PWA) --------------------------------------------------
  var deferredPrompt = null;
  function installBannerAllowed() {
    if (isStandalone || !isMobile) return false;
    var dismissed = Number(read('install_dismissed') || 0);
    return !dismissed || (Date.now() - dismissed) > 7 * 86400000;
  }
  function showInstallBanner(mode) {
    if (document.querySelector('.mwx-install') || !installBannerAllowed()) return;
    if (/^\\/watch\\//.test(location.pathname)) return;
    var box = document.createElement('div');
    box.className = 'mwx-install';
    box.setAttribute('role', 'dialog');
    box.innerHTML = '<img src="' + ICON + '" alt="">'
      + '<div class="mwx-text"><b>Installer ' + APP + '</b><small>'
      + (mode === 'ios' ? 'Partager <span aria-hidden="true">&#x2191;</span> puis « Sur l’écran d’accueil »' : 'Plein écran, icône sur l’accueil, lancement instantané')
      + '</small></div>'
      + (mode === 'ios' ? '' : '<button type="button" class="mwx-go">Installer</button>')
      + '<button type="button" class="mwx-close" aria-label="Fermer">&times;</button>';
    document.body.appendChild(box);
    box.querySelector('.mwx-close').addEventListener('click', function() { store('install_dismissed', Date.now()); box.remove(); });
    var go = box.querySelector('.mwx-go');
    if (go) go.addEventListener('click', function() {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function(choice) {
        if (choice && choice.outcome === 'accepted') { store('install_dismissed', Date.now()); box.remove(); toast(APP + ' installé !'); }
      }).catch(function() {});
    });
  }
  window.addEventListener('beforeinstallprompt', function(event) {
    event.preventDefault();
    deferredPrompt = event;
    setTimeout(function() { showInstallBanner('android'); }, 4000);
  });
  window.addEventListener('appinstalled', function() { store('install_dismissed', Date.now()); var b = document.querySelector('.mwx-install'); if (b) b.remove(); });
  if (isIos && installBannerAllowed()) setTimeout(function() { showInstallBanner('ios'); }, 6000);

  // ---- « Surprends-moi » ---------------------------------------------------
  var fab = null;
  function isHome() { return location.pathname === '/' || location.pathname === ''; }
  function candidates() {
    var seen = {};
    var out = [];
    var anchors = document.querySelectorAll('a[href^="/movie/"], a[href^="/tv/"], a[href^="/anime/"]');
    for (var i = 0; i < anchors.length; i++) {
      var href = anchors[i].getAttribute('href') || '';
      var m = /^\\/(movie|tv|anime)\\/(\\d+)/.exec(href);
      if (!m || seen[href]) continue;
      seen[href] = true;
      out.push({ kind: m[1], id: m[2] });
    }
    return out;
  }
  function surprise() {
    var list = candidates();
    if (!list.length) { toast('Rien à tirer au sort ici'); return; }
    var pick = list[Math.floor(Math.random() * list.length)];
    fab.classList.add('mwx-rolling');
    toast('Tirage en cours…', 1800);
    var url = pick.kind === 'movie' ? '/watch/movie/' + pick.id
      : pick.kind === 'tv' ? '/watch/tv/' + pick.id + '/s/1/e/1'
      : '/watch/anime/' + pick.id + '/season/1/episode/1';
    setTimeout(function() { location.assign(url); }, 650);
  }
  function placeFab() {
    if (!fab) {
      fab = document.createElement('button');
      fab.type = 'button';
      fab.className = 'mwx-fab';
      fab.title = 'Lancer un film ou une série au hasard';
      fab.innerHTML = '<span class="mwx-dice" aria-hidden="true">&#x1F3B2;</span><span class="mwx-label">Surprends-moi</span>';
      fab.addEventListener('click', surprise);
      document.body.appendChild(fab);
    }
    fab.hidden = !isHome();
  }

  // ---- Remonter -----------------------------------------------------------
  var topBtn = null;
  function placeTop() {
    if (!topBtn) {
      topBtn = document.createElement('button');
      topBtn.type = 'button';
      topBtn.className = 'mwx-top';
      topBtn.title = 'Remonter en haut';
      topBtn.innerHTML = '&#x2191;';
      topBtn.addEventListener('click', function() { window.scrollTo({ top: 0, behavior: 'smooth' }); });
      document.body.appendChild(topBtn);
      window.addEventListener('scroll', function() {
        topBtn.classList.toggle('mwx-show', window.scrollY > 900 && !/^\\/watch\\//.test(location.pathname));
      }, { passive: true });
    }
  }

  // ---- Lecteurs externes : porte MEWFLIX -----------------------------------
  // Par défaut aucun lecteur tiers (iframe) ne se charge : ils affichent leurs
  // propres publicités. Quand un titre n'a pas de source directe, le site
  // tente quand même un lecteur externe ; l'iframe est retirée et remplacée
  // par un écran qui explique et laisse le choix. Le choix (clé embeds_mode)
  // est relu à chaque chargement par les retouches partagées, qui activent
  // ou désactivent ces sources dans l'ordre de priorité du site.
  function embedsAllowed() { try { return localStorage.getItem(EMBED_MODE_KEY) === 'on'; } catch (e) { return false; } }
  function setEmbedsMode(on) {
    if (EMBED_API && typeof EMBED_API.setMode === 'function') EMBED_API.setMode(on);
    else {
      try { if (on) localStorage.setItem(EMBED_MODE_KEY, 'on'); else localStorage.removeItem(EMBED_MODE_KEY); } catch (e) {}
      try {
        var raw = localStorage.getItem('settings_source_priority_prefs');
        var prefs = raw ? JSON.parse(raw) : null;
        var tv = prefs && prefs.categories && prefs.categories.moviesTv;
        if (tv && Array.isArray(tv.sourceOrder)) {
          for (var i = 0; i < tv.sourceOrder.length; i++) {
            var entry = tv.sourceOrder[i];
            if (entry && EMBED_IDS.indexOf(entry.id) >= 0) entry.enabled = !!on;
          }
          prefs.updatedAt = Date.now();
          localStorage.setItem('settings_source_priority_prefs', JSON.stringify(prefs));
        }
        if (!on) localStorage.removeItem('playerLastId');
      } catch (e) {}
    }
    location.reload();
  }
  function exemptHost(hostname) {
    hostname = String(hostname || '').toLowerCase();
    for (var i = 0; i < EMBED_EXEMPT.length; i++) {
      if (hostname === EMBED_EXEMPT[i] || hostname.slice(-EMBED_EXEMPT[i].length - 1) === '.' + EMBED_EXEMPT[i]) return true;
    }
    return false;
  }
  function isExternalPlayer(iframe) {
    var src = iframe.getAttribute('src') || '';
    if (!src || src.indexOf('about:') === 0 || src.indexOf('data:') === 0 || src.indexOf('javascript:') === 0) return false;
    try {
      var u = new URL(src, location.href);
      if (u.origin === location.origin) return false;
      return !exemptHost(u.hostname);
    } catch (e) { return false; }
  }
  var gateShown = false;
  function showGate(host, fixed) {
    if (gateShown || !host) return;
    gateShown = true;
    var gate = document.createElement('div');
    gate.className = 'mwx-gate' + (fixed ? ' mwx-fixed' : '');
    gate.innerHTML = '<img src="' + ICON + '" alt="">'
      + '<h3>Pas de source sans publicité</h3>'
      + '<p>Ce titre n’a pas de lecteur direct pour le moment. Les lecteurs externes fonctionnent, mais ils affichent leurs propres publicités dans l’image.</p>'
      + '<div class="mwx-gate-actions">'
      + '<button type="button" class="mwx-gate-on">Lire avec un lecteur externe</button>'
      + '<button type="button" class="mwx-gate-back">Retour</button>'
      + '</div>'
      + '<small>Tu pourras les désactiver à nouveau d’un geste.</small>';
    gate.querySelector('.mwx-gate-on').addEventListener('click', function() { setEmbedsMode(true); });
    gate.querySelector('.mwx-gate-back').addEventListener('click', function() { if (history.length > 1) history.back(); else location.assign('/'); });
    if (!fixed) {
      try {
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
        if (host.offsetHeight < 240) host.style.minHeight = '60vh';
      } catch (e) {}
    }
    host.appendChild(gate);
  }
  // Écran « Contenu non trouvé dans nos sources » du site : il apparaît quand
  // seules des sources externes existent. On explique le vrai choix.
  var NOT_FOUND_RE = /contenu non trouv/i;
  function gateNotFound(root) {
    if (embedsAllowed() || gateShown || !/^\\/watch\\//.test(location.pathname)) return;
    var heads = (root && root.querySelectorAll) ? root.querySelectorAll('h1, h2, h3') : [];
    for (var i = 0; i < heads.length; i++) {
      if (NOT_FOUND_RE.test(heads[i].textContent || '')) { showGate(document.body, true); return; }
    }
  }
  function isWatchPage() { return /^\\/watch\\//.test(location.pathname); }
  function gateIframes(root) {
    if (!isWatchPage() || embedsAllowed()) return;
    gateNotFound(root);
    var frames = (root && root.querySelectorAll) ? root.querySelectorAll('iframe') : [];
    for (var i = 0; i < frames.length; i++) {
      var frame = frames[i];
      if (frame.getAttribute('data-mwx-gated') || !isExternalPlayer(frame)) continue;
      // Le nœud reste en place (React le gère) : chargement coupé et masqué.
      frame.setAttribute('data-mwx-gated', '1');
      frame.setAttribute('src', 'about:blank');
      frame.style.setProperty('display', 'none', 'important');
      showGate(frame.parentElement);
    }
  }
  function placeEmbedBanner() {
    if (!embedsAllowed() || !/^\\/watch\\//.test(location.pathname) || document.querySelector('.mwx-embed-banner')) return;
    var bar = document.createElement('div');
    bar.className = 'mwx-embed-banner';
    bar.innerHTML = '<span>Lecteurs externes activés · publicités possibles</span><button type="button">Désactiver</button>';
    bar.querySelector('button').addEventListener('click', function() { setEmbedsMode(false); });
    document.body.appendChild(bar);
  }

  // ---- Navigation SPA : l'URL change sans rechargement ------------------------
  var lastPath = location.pathname;
  function onRoute() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    if (fab) fab.hidden = !isHome();
    if (topBtn) topBtn.classList.remove('mwx-show');
  }
  var pushState = history.pushState;
  history.pushState = function() { var r = pushState.apply(this, arguments); setTimeout(onRoute, 0); return r; };
  var replaceState = history.replaceState;
  history.replaceState = function() { var r = replaceState.apply(this, arguments); setTimeout(onRoute, 0); return r; };
  window.addEventListener('popstate', function() { setTimeout(onRoute, 0); });

  function start() {
    placeFab();
    placeTop();
    placeEmbedBanner();
    gateIframes(document.body);
    registerSw();
    new MutationObserver(function(mutations) {
      if (!isWatchPage()) return;
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          // Un texte remplacé dans un titre existant (React) n'ajoute qu'un nœud texte.
          if (node.nodeType === 3) { if (node.parentElement) gateNotFound(node.parentElement.parentElement || node.parentElement); continue; }
          if (node.nodeType !== 1) continue;
          if (node.tagName === 'IFRAME') gateIframes(node.parentElement);
          else gateIframes(node);
        }
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    // Filet de sécurité sur les pages de lecture : relecture légère toutes les 2 s.
    setInterval(function() { if (isWatchPage()) gateIframes(document.body); }, 2000);
    // Un lecteur peut aussi recevoir son adresse après insertion.
    var setAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value) {
      var r = setAttribute.call(this, name, value);
      if (this.tagName === 'IFRAME' && String(name).toLowerCase() === 'src' && this.parentElement) gateIframes(this.parentElement);
      return r;
    };
    try { console.info('%c' + APP + ' web ' + BUILD, 'color:' + ACCENT + ';font-weight:700'); } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
`;
}
