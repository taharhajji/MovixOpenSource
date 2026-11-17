/* MEWFLIX — interface du mode TV.
 *
 * Injectée dans la page du site quand le mode TV est actif (main.js). Hors des
 * pages de lecture, elle recouvre entièrement le site d'une interface pensée
 * pour la télé : rangées d'affiches, fiche détaillée, recherche, TV en direct,
 * le tout piloté aux flèches / OK / Retour (clavier ou téléphone). Sur une
 * page de lecture (/watch/…), le lecteur du site occupe l'écran et seules les
 * touches sont gérées ici.
 *
 * Script navigateur autonome : configuration dans window.__MEWFLIX_TV_CONFIG__,
 * navigation spatiale et pilotage vidéo dans window.__mewflixPickNext et
 * window.__mewflixControlVideo (src/lib/tvNav.js).
 * Tout le texte venant de l'extérieur passe par textContent.
 */
(function () {
  'use strict';
  if (window.__MEWFLIX_TV_ACTIVE__) return;
  window.__MEWFLIX_TV_ACTIVE__ = true;

  var CFG = window.__MEWFLIX_TV_CONFIG__ || {};
  var pickNext = window.__mewflixPickNext;
  var controlVideo = window.__mewflixControlVideo;
  var bridge = (window.__movixDesktop && window.__movixDesktop.tv) || null;
  var APP = CFG.appName || 'MEWFLIX';
  var TMDB = 'https://api.themoviedb.org/3';
  var IMG = 'https://image.tmdb.org/t/p/';
  var STATE_KEY = 'mewflix_tv_state';
  // Variantes : appli de bureau (téléphone en télécommande, mode à quitter) ou
  // appli Android TV (android-tv/ : télécommande de la télé, pas d'autre mode).
  // Page d'accueil de l'interface. Bureau : la racine du site. Android TV :
  // une page légère du même site (homePath), pour ne pas recharger tout le site
  // derrière l'interface à chaque retour d'une vidéo.
  var HOME = typeof CFG.homePath === 'string' && CFG.homePath.charAt(0) === '/' ? CFG.homePath : '/';
  var PHONE_REMOTE = CFG.phoneRemote !== false;
  var STANDALONE = CFG.standalone === true;
  var isWatchPath = function () { return /^\/watch\//.test(location.pathname); };

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value == null || value === false) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'on') Object.keys(value).forEach(function (name) { node.addEventListener(name, value[name]); });
        else node.setAttribute(key, value === true ? '' : String(value));
      });
    }
    (children || []).forEach(function (child) { if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child); });
    return node;
  }
  function readJson(storage, key, fallback) {
    try { var raw = storage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; }
  }
  function writeJson(storage, key, value) {
    try { storage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }

  // Bandeau bref (« Volume 80 % », « Pause ») : pages de lecture et chaînes en direct.
  var hud = null;
  var hudTimer = null;
  function showHud(text) {
    var host = document.getElementById('mewflix-tv') || document.body;
    if (!host) return;
    if (!hud || hud.parentNode !== host) {
      if (hud) hud.remove();
      hud = el('div', { style: 'position:fixed;z-index:2147483647;left:50%;top:9vh;transform:translateX(-50%);padding:1.4vh 3vh;border-radius:999px;background:rgba(20,21,24,.86);color:#e7edf7;font:600 3vh system-ui,sans-serif;pointer-events:none;transition:opacity .25s;opacity:0' });
      host.appendChild(hud);
    }
    hud.textContent = text;
    hud.style.opacity = '1';
    clearTimeout(hudTimer);
    hudTimer = setTimeout(function () { hud.style.opacity = '0'; }, 1300);
  }
  window.__mewflixTvHud = showHud;

  // ======================================================================
  // Page de lecture : le lecteur du site occupe l'écran.
  // ======================================================================
  function playerMode() {
    var ACCENT = CFG.accent || '#dbe6f6';
    // Deux modes. « Vidéo » (par défaut) : OK = pause, ← → = reculer/avancer ;
    // le volume reste aux boutons volume de la télécommande. « Boutons » (↑ ↓ ou
    // Menu) : un cadre circule entre les boutons du lecteur (sources, épisodes,
    // sous-titres…), OK appuie, Retour revient à la vidéo.
    var navMode = false;
    var current = null;
    var lastRect = null;
    var frame = null;
    var navTimer = null;
    var navTicks = 0;
    var NAV_RETRY_MS = 300;
    var NAV_RETRIES = 4;
    var wakeShift = 0;
    var SELECTOR = 'button, a[href], [role="button"], [role="menuitem"], [role="menuitemradio"], [role="option"], [role="tab"], [role="slider"], input, select';
    function leave() {
      location.assign(HOME);
    }
    function isShown(node) {
      if (node.disabled || !node.getClientRects().length) return false;
      var r = node.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
      var style = getComputedStyle(node);
      return style.visibility !== 'hidden' && style.display !== 'none' && style.pointerEvents !== 'none';
    }
    function buttons() {
      return Array.prototype.filter.call(document.querySelectorAll(SELECTOR), isShown);
    }
    // Les commandes du lecteur du site n'apparaissent qu'au mouvement de la souris.
    function wakeControls() {
      var target = document.querySelector('video') || document.body;
      if (!target) return;
      var r = target.getBoundingClientRect();
      // Position légèrement différente à chaque fois : le lecteur ignore un
      // « mouvement » qui ne bouge pas.
      wakeShift = (wakeShift + 1) % 4;
      var init = { bubbles: true, clientX: r.left + r.width / 2 + wakeShift * 3, clientY: r.top + r.height * 0.8 };
      try {
        target.dispatchEvent(new MouseEvent('mousemove', init));
        if (typeof PointerEvent === 'function') target.dispatchEvent(new PointerEvent('pointermove', init));
      } catch (e) { /* navigateur ancien */ }
    }
    // Le lecteur du site redessine ses boutons (React) : l'élément encadré peut
    // être remplacé par un autre au même endroit. On le retrouve par sa position.
    function resolveCurrent() {
      if (current && current.isConnected && isShown(current)) return current;
      current = null;
      if (!lastRect) return null;
      var hit = document.elementFromPoint(lastRect.left + lastRect.width / 2, lastRect.top + lastRect.height / 2);
      var node = hit && hit.closest ? hit.closest(SELECTOR) : null;
      if (node && isShown(node)) current = node;
      return current;
    }
    // Cadre dessiné par-dessus la page (le style du site ne peut pas le masquer).
    function drawFrame() {
      if (!frame || !frame.isConnected) {
        frame = el('div', { 'aria-hidden': 'true', style: 'position:fixed;z-index:2147483646;pointer-events:none;border:4px solid ' + ACCENT + ';border-radius:10px;box-shadow:0 0 0 3px rgba(0,0,0,.6),0 0 22px ' + ACCENT + ';transition:left .12s,top .12s,width .12s,height .12s;display:none' });
        (document.body || document.documentElement).appendChild(frame);
      }
      var node = navMode ? resolveCurrent() : null;
      if (!node) { frame.style.display = 'none'; return; }
      var r = node.getBoundingClientRect();
      lastRect = r;
      frame.style.left = (r.left - 6) + 'px';
      frame.style.top = (r.top - 6) + 'px';
      frame.style.width = (r.width + 12) + 'px';
      frame.style.height = (r.height + 12) + 'px';
      frame.style.display = 'block';
    }
    function mark(node) {
      current = node;
      lastRect = node.getBoundingClientRect();
      try { node.focus({ preventScroll: true }); } catch (e) { /* élément non focalisable */ }
      if (node.scrollIntoView) node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      drawFrame();
    }
    // Sans curseur, on part du bord opposé de l'écran : ↑ vise d'abord la barre
    // du bas (commandes du lecteur), ↓ les boutons du haut.
    function moveFocus(dir) {
      wakeControls();
      var nodes = buttons();
      if (!nodes.length || !pickNext) return false;
      var here = resolveCurrent();
      var from = here ? here.getBoundingClientRect() : (navMode ? lastRect : null);
      if (!from) {
        var y = dir === 'up' ? innerHeight + 1 : (dir === 'down' ? -1 : innerHeight / 2);
        var x = dir === 'left' ? innerWidth + 1 : (dir === 'right' ? -1 : innerWidth / 2);
        from = { left: x, right: x, top: y, bottom: y, width: 0, height: 0 };
      }
      var index = pickNext(from, nodes.map(function (n) { return n.getBoundingClientRect(); }), dir);
      if (index < 0) return Boolean(here);
      mark(nodes[index]);
      return true;
    }
    // Les commandes masquées du lecteur réapparaissent un instant après le
    // réveil : si aucun bouton n'est encore là, on réessaie peu après.
    function enterNav(dir) {
      lastRect = null;
      current = null;
      navMode = true;
      showHud('Boutons du lecteur · Retour : revenir à la vidéo');
      if (moveFocus(dir)) { startNav(); return; }
      var tries = 0;
      (function retry() {
        setTimeout(function () {
          if (!navMode || current) return;
          if (moveFocus(dir)) { startNav(); return; }
          tries += 1;
          if (tries < NAV_RETRIES) { retry(); return; }
          navMode = false;
          showHud('Aucun bouton à l’écran');
        }, NAV_RETRY_MS);
      })();
    }
    function startNav() {
      clearInterval(navTimer);
      navTicks = 0;
      // Tant que le mode boutons est actif : commandes du lecteur gardées
      // visibles et cadre recalé si la page bouge.
      navTimer = setInterval(function () {
        navTicks += 1;
        if (navTicks % 5 === 0) wakeControls();
        drawFrame();
      }, 400);
    }
    function exitNav() {
      navMode = false;
      clearInterval(navTimer);
      current = null;
      lastRect = null;
      drawFrame();
      showHud('▶ Vidéo');
    }
    window.__mewflixTvPlayerState = function () {
      var node = navMode ? resolveCurrent() : null;
      var name = node ? (node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent || node.tagName) : '';
      return { nav: navMode, current: String(name).replace(/\s+/g, ' ').trim().slice(0, 40) };
    };
    function isArrow(key) { return key === 'up' || key === 'down' || key === 'left' || key === 'right'; }
    // Appui complet (pointeur puis clic) : certains menus du lecteur s'ouvrent à
    // l'appui du pointeur et ignorent un simple click().
    function press() {
      var node = resolveCurrent();
      if (!node) return false;
      var r = node.getBoundingClientRect();
      var base = { bubbles: true, cancelable: true, view: window, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      var pointer = { pointerId: 1, pointerType: 'mouse', isPrimary: true };
      try {
        var down = Object.assign({ buttons: 1 }, base);
        var up = Object.assign({ buttons: 0 }, base);
        if (typeof PointerEvent === 'function') node.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, down, pointer)));
        node.dispatchEvent(new MouseEvent('mousedown', down));
        if (typeof PointerEvent === 'function') node.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, up, pointer)));
        node.dispatchEvent(new MouseEvent('mouseup', up));
      } catch (e) { /* navigateur ancien : le clic seul */ }
      node.click();
      // La page peut changer (menu ouvert, autre source) : le cadre suit.
      setTimeout(function () { wakeControls(); drawFrame(); }, 300);
      return true;
    }
    // Retourne 'no-video' quand la page n'a pas de vidéo à elle : l'appelant
    // essaie alors les iframes des lecteurs externes, puis __mewflixTvFallback.
    window.__mewflixTvKey = function (key) {
      if (key === 'home') { leave(); return 'left'; }
      if (navMode) {
        if (key === 'back' || key === 'menu') { exitNav(); return 'done'; }
        if (isArrow(key)) { moveFocus(key); return 'done'; }
        if (key === 'ok') { if (!press()) exitNav(); return 'done'; }
      }
      if (key === 'back') { leave(); return 'left'; }
      if (key === 'up' || key === 'down' || key === 'menu') { enterNav(key === 'menu' ? 'up' : key); return 'done'; }
      var label = controlVideo ? controlVideo(document, key) : '';
      if (!label) return 'no-video';
      showHud(label);
      return 'done';
    };
    // Ni vidéo dans la page ni lecteur externe qui réponde (écran d'erreur ou de
    // choix du site) : les flèches circulent entre les boutons.
    window.__mewflixTvFallback = function (key) {
      if (isArrow(key)) {
        if (!navMode) enterNav(key);
        else moveFocus(key);
        return 'moved';
      }
      if (key === 'ok' && press()) return 'clicked';
      return 'none';
    };
    window.__mewflixTvNav = function (screen) {
      writeJson(sessionStorage, STATE_KEY, { stack: [{ name: screen }], focus: '' });
      leave();
    };
    window.__mewflixTvText = function () {};
    window.addEventListener('keydown', function (event) {
      var typing = /^(INPUT|TEXTAREA|SELECT)$/.test((event.target && event.target.tagName) || '');
      if (event.key === 'BrowserBack' || (event.key === 'Backspace' && !typing)
          || (event.key === 'Escape' && !document.fullscreenElement && !document.querySelector('[role="dialog"]'))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (navMode) exitNav();
        else leave();
      }
    }, true);
    // Le site est une application à page unique : s'il quitte la lecture par
    // sa propre navigation, on revient à l'interface TV.
    setInterval(function () { if (!isWatchPath()) location.replace(HOME); }, 700);
    setTimeout(function () { if (!navMode) showHud('↑ ↓ : boutons du lecteur · ← → : reculer / avancer'); }, 4000);
  }

  if (isWatchPath()) { playerMode(); return; }

  // ======================================================================
  // Interface TV (recouvre le site).
  // ======================================================================
  var ACCENT = CFG.accent || '#dbe6f6';
  var CSS = [
    'html.mewflix-tv, html.mewflix-tv body { background: #0d0e11 !important; overflow: hidden !important; scrollbar-gutter: auto !important; }',
    'html.mewflix-tv body > *:not(#mewflix-tv) { display: none !important; }',
    '#mewflix-tv { position: fixed; inset: 0; z-index: 2147483000; background: #0d0e11; color: #e7edf7; font: 400 2.1vh/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; overflow: hidden; }',
    '#mewflix-tv.idle, #mewflix-tv.idle * { cursor: none !important; }',
    '#mewflix-tv *, #mewflix-tv *::before { box-sizing: border-box; }',
    ':where(#mewflix-tv) button { font: inherit; color: inherit; border: 0; background: none; padding: 0; margin: 0; cursor: pointer; text-align: left; }',
    '#mewflix-tv [data-f] { outline: none; }',
    '.tv-rail { position: absolute; left: 0; top: 0; bottom: 0; width: 11vh; display: flex; flex-direction: column; align-items: stretch; gap: 1.2vh; padding: 3vh 1.4vh; background: #0d0e11; z-index: 5; transition: width .18s ease; overflow: hidden; }',
    '.tv-rail.open { width: 38vh; background: linear-gradient(90deg, #0d0e11 72%, rgba(13,14,17,0)); }',
    '.tv-nav span, .tv-logo span { opacity: 0; transition: opacity .15s ease; }',
    '.tv-rail.open .tv-nav span, .tv-rail.open .tv-logo span { opacity: 1; }',
    '.tv-logo { display: flex; align-items: center; gap: 1.6vh; height: 8vh; padding: 0 1.2vh; margin-bottom: 2vh; font-weight: 800; letter-spacing: .12em; font-size: 2.6vh; white-space: nowrap; color: ' + ACCENT + '; }',
    '.tv-logo img { width: 5.6vh; height: 5.6vh; border-radius: 1.3vh; flex: none; }',
    '.tv-nav { display: flex; align-items: center; gap: 2.2vh; height: 7.4vh; padding: 0 2.3vh; border-radius: 1.8vh; white-space: nowrap; color: #9fb3d1; font-weight: 600; font-size: 2.3vh; }',
    '.tv-nav svg { width: 3.4vh; height: 3.4vh; flex: none; }',
    '.tv-exit { margin-top: auto; }',
    '.tv-nav.current { color: #e7edf7; background: rgba(219,230,246,.09); }',
    '.tv-nav.tv-on { color: #141518; background: ' + ACCENT + '; }',
    '.tv-main { position: absolute; left: 11vh; right: 0; top: 0; bottom: 0; }',
    '.tv-screen { position: absolute; inset: 0; overflow: hidden; }',
    '.tv-backdrop { position: absolute; inset: 0 0 auto 0; height: 78vh; background: #0d0e11 center top / cover no-repeat; opacity: .55; transition: background-image .35s ease; }',
    '.tv-backdrop::after { content: ""; position: absolute; inset: 0; background: linear-gradient(90deg, #0d0e11 8%, rgba(13,14,17,.55) 48%, rgba(13,14,17,.15)), linear-gradient(0deg, #0d0e11 2%, rgba(13,14,17,0) 55%); }',
    '.tv-hero { position: relative; height: 42vh; padding: 6vh 5vh 0 3vh; display: flex; flex-direction: column; justify-content: flex-end; }',
    '.tv-hero h1 { margin: 0 0 1.2vh; font-size: 6vh; line-height: 1.05; font-weight: 800; max-width: 60%; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }',
    '.tv-meta { display: flex; flex-wrap: wrap; gap: 1.6vh; align-items: center; color: #c5d3ea; font-weight: 600; font-size: 2.1vh; margin-bottom: 1.2vh; }',
    '.tv-meta .pill { padding: .3vh 1.2vh; border-radius: 999px; background: rgba(219,230,246,.14); }',
    '.tv-meta .star { color: #f3c969; }',
    '.tv-overview { max-width: 54%; color: #b8c5db; font-size: 2.15vh; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; min-height: 9vh; }',
    '.tv-rows { position: absolute; left: 0; right: 0; top: 44vh; bottom: 0; overflow: hidden; }',
    '.tv-rows-inner { transition: transform .22s ease; padding-bottom: 30vh; }',
    '.tv-row { padding: 1.4vh 0 .6vh; }',
    '.tv-row h2 { margin: 0 0 1vh 3vh; font-size: 2.5vh; font-weight: 700; color: #dfe7f5; }',
    '.tv-strip { display: flex; gap: 1.8vh; padding: 1.4vh 3vh; overflow: hidden; scroll-behavior: smooth; }',
    '.tv-card { position: relative; flex: none; width: 19vh; aspect-ratio: 2 / 3; border-radius: 1.4vh; overflow: hidden; background: #1c1f26; transition: transform .14s ease, box-shadow .14s ease; }',
    '.tv-card.wide { width: 36vh; aspect-ratio: 16 / 9; }',
    '.tv-card img { width: 100%; height: 100%; object-fit: cover; display: block; }',
    '.tv-card .cap { position: absolute; inset: auto 0 0 0; padding: 4vh 1.2vh 1vh; background: linear-gradient(0deg, rgba(0,0,0,.85), rgba(0,0,0,0)); font-size: 1.8vh; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
    '.tv-card .bar { position: absolute; left: 0; bottom: 0; height: .7vh; background: ' + ACCENT + '; }',
    '.tv-card.tv-on, .tv-tile.tv-on, .tv-btn.tv-on, .tv-chip.tv-on, .tv-key.tv-on { transform: scale(1.07); box-shadow: 0 0 0 .55vh ' + ACCENT + ', 0 2vh 5vh rgba(0,0,0,.6); z-index: 2; }',
    '.tv-btn.primary.tv-on { box-shadow: 0 0 0 .55vh #ffffff, 0 2vh 5vh rgba(0,0,0,.6); }',
    '.tv-page { position: absolute; inset: 0; padding: 5vh 5vh 0 3vh; overflow: hidden; }',
    '.tv-page h1 { margin: 0 0 2vh; font-size: 4.4vh; font-weight: 800; }',
    '.tv-scroll { position: absolute; left: 0; right: 0; bottom: 0; overflow: hidden; }',
    '.tv-scroll-inner { transition: transform .22s ease; padding: 1.5vh 5vh 30vh 3vh; }',
    '.tv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(19vh, 1fr)); gap: 2.2vh; }',
    '.tv-grid .tv-card { width: 100%; }',
    '.tv-grid.tiles { grid-template-columns: repeat(auto-fill, minmax(30vh, 1fr)); }',
    '.tv-tile { display: flex; align-items: center; justify-content: center; text-align: center; min-height: 12vh; padding: 1.5vh 2vh; border-radius: 1.6vh; background: #1c1f26; font-weight: 700; font-size: 2.2vh; transition: transform .14s ease, box-shadow .14s ease; }',
    '.tv-chips { display: flex; flex-wrap: wrap; gap: 1.4vh; margin-bottom: 2vh; }',
    '.tv-chip { padding: 1.1vh 2.4vh; border-radius: 999px; background: rgba(219,230,246,.1); font-weight: 600; transition: transform .14s ease, box-shadow .14s ease; }',
    '.tv-chip.current { background: rgba(219,230,246,.26); }',
    '.tv-chipline { gap: 1.4vh; padding: 1.2vh .8vh; }',
    '.tv-chipline .tv-chip { flex: none; white-space: nowrap; }',
    '.tv-btn { display: inline-flex; align-items: center; gap: 1.2vh; padding: 1.7vh 3.4vh; border-radius: 1.6vh; background: rgba(219,230,246,.14); font-weight: 700; font-size: 2.4vh; transition: transform .14s ease, box-shadow .14s ease; }',
    '.tv-btn.primary { background: ' + ACCENT + '; color: #141518; }',
    '.tv-actions { display: flex; flex-wrap: wrap; gap: 2vh; margin: 2.4vh 0; }',
    '.tv-detail { position: relative; padding: 9vh 0 0 0; }',
    '.tv-detail h1 { margin: 0 0 1.4vh; font-size: 6.4vh; line-height: 1.05; font-weight: 800; max-width: 70%; }',
    '.tv-detail .tv-overview { max-width: 62%; -webkit-line-clamp: 4; }',
    '.tv-keys { display: grid; grid-template-columns: repeat(6, 1fr); gap: 1vh; width: 52vh; flex: none; align-content: start; }',
    '.tv-key { display: flex; align-items: center; justify-content: center; height: 6.2vh; border-radius: 1.2vh; background: #1c1f26; font-weight: 700; transition: transform .14s ease, box-shadow .14s ease; }',
    '.tv-key.wide { grid-column: span 2; font-size: 1.8vh; }',
    '.tv-query { height: 7vh; display: flex; align-items: center; padding: 0 2.4vh; margin-bottom: 2vh; border-radius: 1.4vh; background: #1c1f26; font-size: 2.8vh; font-weight: 600; width: 52vh; white-space: nowrap; overflow: hidden; }',
    '.tv-query.empty { color: #6e83ab; font-weight: 400; font-size: 2vh; }',
    '.tv-search { position: absolute; left: 3vh; right: 0; top: 14vh; bottom: 0; display: flex; gap: 4vh; }',
    '.tv-results { position: relative; flex: 1; min-width: 0; overflow: hidden; }',
    '.tv-note { color: #9fb3d1; font-size: 2.2vh; margin: 2vh 0; max-width: 90vh; }',
    '.tv-clock { position: absolute; right: 4vh; top: 3vh; z-index: 4; color: #c5d3ea; font-weight: 600; font-size: 2.4vh; text-shadow: 0 .2vh 1vh rgba(0,0,0,.7); }',
    '.tv-layer { position: absolute; inset: 0; z-index: 20; background: rgba(8,9,11,.94); display: flex; align-items: center; justify-content: center; }',
    '.tv-dialog { display: flex; gap: 6vh; align-items: center; max-width: 130vh; padding: 5vh 6vh; border-radius: 3vh; background: #171a20; border: .2vh solid rgba(219,230,246,.14); }',
    '.tv-dialog img.qr { width: 40vh; height: 40vh; border-radius: 2vh; background: #fff; flex: none; }',
    '.tv-dialog h2 { margin: 0 0 1.6vh; font-size: 4.2vh; }',
    '.tv-dialog ol { margin: 0 0 2.4vh; padding-left: 3.4vh; color: #c5d3ea; font-size: 2.4vh; line-height: 1.7; list-style: decimal; }',
    '.tv-dialog code { color: ' + ACCENT + '; font-size: 2.3vh; white-space: nowrap; }',
    '.tv-live { position: absolute; inset: 0; z-index: 30; background: #000; }',
    '.tv-live iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #000; }',
    '.tv-live .name { position: absolute; left: 3vh; top: 3vh; z-index: 2; padding: 1vh 2.2vh; border-radius: 999px; background: rgba(20,21,24,.8); font-weight: 700; transition: opacity .4s; }',
  ].join('\n');

  var ICONS = {
    home: 'M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
    movies: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm0 3h3M4 12h3M4 16h3M17 8h3M17 12h3M17 16h3M8 5v14M16 5v14',
    series: 'M3 6h18v11H3zM8 21h8M12 17v4',
    live: 'M4 8h16v11H4zM8 3l4 5 4-5M9 13.5l4 2.5V11z',
    search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zm5 12 4.5 4.5',
    exit: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
    settings: 'M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM4 12h2M18 12h2M12 4v2M12 18v2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4',
  };
  function icon(name) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICONS[name]);
    svg.appendChild(path);
    return svg;
  }

  // ---- Données (TMDB + API du site) ------------------------------------------
  // Cache du catalogue : mémoire + sessionStorage, avec expiration (l'app
  // reste ouverte des jours sur une télé) et sans la clé d'API dans les clés.
  var memory = {};
  var memoryCount = 0;
  var CACHE_PREFIX = 'mewflix_tv_c:';
  var LIST_TTL_MS = 30 * 60 * 1000;         // rangées : rafraîchies toutes les 30 minutes
  var DETAIL_TTL_MS = 24 * 60 * 60 * 1000;  // fiches et saisons : une journée
  var MEMORY_MAX = 200;
  function cacheTtl(path) {
    var first = (path.split('/')[2] || '').charAt(0);
    return first >= '0' && first <= '9' ? DETAIL_TTL_MS : LIST_TTL_MS;
  }
  function dropCache() {
    try {
      var keys = [];
      for (var i = 0; i < sessionStorage.length; i++) {
        var key = sessionStorage.key(i);
        if (key && key.indexOf(CACHE_PREFIX) === 0) keys.push(key);
      }
      keys.forEach(function (key) { sessionStorage.removeItem(key); });
    } catch (e) { /* stockage fermé */ }
  }
  // Stockage plein : le cache du catalogue est sacrifié, puis on réessaie une fois.
  function store(key, value) {
    if (writeJson(sessionStorage, key, value)) return true;
    dropCache();
    return writeJson(sessionStorage, key, value);
  }
  function tmdb(path, params) {
    var url = new URL(TMDB + path);
    url.searchParams.set('language', 'fr-FR');
    Object.keys(params || {}).forEach(function (key) { url.searchParams.set(key, params[key]); });
    var id = url.pathname + url.search;
    url.searchParams.set('api_key', CFG.tmdbKey || '');
    var hit = memory[id] || readJson(sessionStorage, CACHE_PREFIX + id, null);
    if (hit && hit.data && Date.now() - hit.t < cacheTtl(path)) {
      memory[id] = hit;
      return Promise.resolve(hit.data);
    }
    return fetch(url.href).then(function (res) {
      if (!res.ok) throw new Error('Catalogue indisponible (' + res.status + ')');
      return res.json();
    }).then(function (data) {
      if (memoryCount >= MEMORY_MAX) { memory = {}; memoryCount = 0; }
      if (!memory[id]) memoryCount += 1;
      memory[id] = { t: Date.now(), data: data };
      if (path.indexOf('/search/') !== 0) store(CACHE_PREFIX + id, memory[id]);
      return data;
    }, function (err) {
      // Réseau coupé : une réponse périmée vaut mieux qu'un écran vide.
      if (hit && hit.data) return hit.data;
      throw err;
    });
  }
  function normalize(item, forcedType) {
    var type = item.media_type || forcedType;
    if (type !== 'movie' && type !== 'tv') return null;
    if (!item.poster_path && !item.backdrop_path) return null;
    var date = item.release_date || item.first_air_date || '';
    return {
      id: item.id, type: type, title: item.title || item.name || '',
      poster: item.poster_path ? IMG + 'w342' + item.poster_path : '',
      backdrop: item.backdrop_path ? IMG + 'w1280' + item.backdrop_path : '',
      overview: item.overview || '', year: date.slice(0, 4),
      rating: item.vote_average ? Math.round(item.vote_average * 10) / 10 : 0,
      votes: item.vote_count || 0,
    };
  }
  function list(path, params, forcedType) {
    return tmdb(path, params).then(function (data) {
      return (data.results || []).map(function (item) { return normalize(item, forcedType); }).filter(Boolean);
    });
  }
  // API du site (chaînes en direct) : son adresse dépend du miroir. On essaie,
  // dans l'ordre, celle qui a déjà répondu, les hôtes « api.* » vus dans les
  // requêtes de la page, puis les adresses connues ; la première qui répond
  // est retenue pour la session.
  var API_BASE_KEY = 'mewflix_tv_api';
  var API_DEFAULTS = ['https://api.movix.luxe', 'https://api.movix.miami'];
  var MAX_API_BASES = 6;
  function apiBases() {
    var seen = {};
    var out = [];
    function add(base) { if (base && !seen[base]) { seen[base] = true; out.push(base); } }
    add(readJson(sessionStorage, API_BASE_KEY, ''));
    var entries = performance.getEntriesByType('resource');
    for (var i = entries.length - 1; i >= 0 && out.length < MAX_API_BASES; i--) {
      var m = /^(https:\/\/api\.movix\.[a-z]{2,12})\//.exec(entries[i].name);
      if (m) add(m[1]);
    }
    // Même domaine que la page : api.<miroir> (aucune requête du site à observer sur la page légère).
    if (location.hostname.indexOf('movix.') === 0) add('https://api.' + location.hostname);
    (CFG.apiBases || API_DEFAULTS).forEach(add);
    return out.slice(0, MAX_API_BASES);
  }
  function siteApi(path) {
    var bases = apiBases();
    function attempt(index, lastError) {
      if (index >= bases.length) return Promise.reject(lastError || new Error('Service indisponible'));
      return fetch(bases[index] + path).then(function (res) {
        if (!res.ok) throw new Error('Service indisponible (' + res.status + ')');
        return res.json();
      }).then(function (data) {
        writeJson(sessionStorage, API_BASE_KEY, bases[index]);
        return data;
      }, function (err) {
        return attempt(index + 1, err);
      });
    }
    return attempt(0, null);
  }
  function watchUrl(item, season, episode) {
    return item.type === 'movie' ? '/watch/movie/' + item.id : '/watch/tv/' + item.id + '/s/' + (season || 1) + '/e/' + (episode || 1);
  }
  function resumeEntries() {
    var data = readJson(localStorage, 'continueWatching', null) || {};
    var out = [];
    (data.movies || []).forEach(function (entry) {
      var id = typeof entry === 'number' ? entry : entry && entry.id;
      if (id) out.push({ type: 'movie', id: Number(id), at: (entry && entry.lastAccessed) || '' });
    });
    (data.tv || []).forEach(function (entry) {
      if (!entry || !entry.id) return;
      var ep = entry.currentEpisode || {};
      out.push({ type: 'tv', id: Number(entry.id), at: entry.lastAccessed || '', season: ep.season || ep.season_number, episode: ep.episode || ep.episode_number });
    });
    out.sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); });
    return out.slice(0, 12);
  }

  // ---- Structure ------------------------------------------------------------
  var root = el('div', { id: 'mewflix-tv' });
  var rail = el('nav', { class: 'tv-rail' });
  var main = el('div', { class: 'tv-main' });
  var clock = el('div', { class: 'tv-clock' });
  var NAV = [['home', 'Accueil'], ['movies', 'Films'], ['series', 'Séries'], ['live', 'TV en direct'], ['search', 'Recherche'], ['settings', 'Réglages']];
  var navButtons = {};
  var stack = [{ name: 'home' }];
  var layer = null;       // boîte de dialogue ou lecteur en direct au premier plan
  var screenNode = null;
  var screenApi = null;   // fonctions propres à l'écran affiché (recherche)
  var pendingFocus = '';
  var wantsContent = false;   // écran tout juste affiché : le curseur va au contenu dès qu'il arrive
  var lastContentFocus = null;
  var renderSeq = 0;          // change à chaque écran : les réponses tardives d'un écran quitté sont ignorées
  var userMoved = false;      // un appui ou la souris depuis l'affichage de l'écran : le curseur n'est plus replacé d'office

  function current() { return stack[stack.length - 1]; }
  function saveState() {
    var active = cursor();
    store(STATE_KEY, { stack: stack, focus: (active && active.getAttribute('data-fk')) || '' });
  }
  function play(url) { saveState(); location.assign(url); }

  // ---- Curseur --------------------------------------------------------------
  function scope() { return layer || root; }
  function focusables() {
    return Array.prototype.filter.call(scope().querySelectorAll('[data-f]'), function (n) { return n.offsetParent !== null; });
  }
  function reveal(node) {
    // Défilement maison : chaque conteneur glisse pour garder le curseur visible.
    var strip = node.closest('.tv-strip');
    if (strip) {
      var target = node.offsetLeft - strip.clientWidth / 2 + node.offsetWidth / 2;
      strip.scrollLeft = Math.max(0, target);
    }
    var inner = node.closest('.tv-rows-inner, .tv-scroll-inner');
    if (inner) {
      var holder = inner.parentElement;
      var block = node.closest('.tv-row') || node;
      var top = block.getBoundingClientRect().top - inner.getBoundingClientRect().top;
      // Rangées d'accueil : la rangée ciblée en haut de la zone. Pages longues
      // (fiche, grilles) : le bloc ciblé au milieu, l'en-tête reste visible au début.
      var wanted = inner.classList.contains('tv-rows-inner')
        ? top
        : top + block.getBoundingClientRect().height / 2 - holder.clientHeight / 2;
      var max = Math.max(0, inner.scrollHeight - holder.clientHeight * 0.6);
      inner.style.transform = 'translateY(' + (-Math.max(0, Math.min(max, wanted))) + 'px)';
    }
  }
  // Le curseur est une classe posée par le script, pas :focus : il reste
  // visible même si la fenêtre n'est pas au premier plan sous Windows.
  var marked = null;
  // Position du curseur : l'élément marqué, jamais document.activeElement (le
  // navigateur déplace son focus de lui-même, notamment un WebView Android
  // quand il reçoit le focus de la télé).
  function cursor() {
    return marked && marked.isConnected && scope().contains(marked) && marked.offsetParent !== null ? marked : null;
  }
  function clearMark() {
    if (marked) marked.classList.remove('tv-on');
    marked = null;
    rail.classList.remove('open');
  }
  function markFocus(node) {
    if (marked && marked !== node) marked.classList.remove('tv-on');
    marked = node;
    node.classList.add('tv-on');
    rail.classList.toggle('open', rail.contains(node));
    if (node.__tvFocus) node.__tvFocus();
  }
  function setFocus(node) {
    if (!node) return false;
    node.focus({ preventScroll: true });
    markFocus(node);
    reveal(node);
    if (!layer && !rail.contains(node)) { wantsContent = false; lastContentFocus = node; }
    return true;
  }
  // Curseur mémorisé (retour d'une fiche, d'une lecture) : posé dès que son
  // élément existe, à chaque arrivée de contenu.
  function applyPending() {
    if (!pendingFocus) return false;
    var wanted = focusables().filter(function (n) { return n.getAttribute('data-fk') === pendingFocus; })[0];
    if (!wanted) return false;
    pendingFocus = '';
    return setFocus(wanted);
  }
  function focusFirst(selector) {
    if (applyPending()) return true;
    var nodes = focusables();
    var inContent = nodes.filter(function (n) { return layer || (!rail.contains(n) && (!selector || n.matches(selector))); });
    return setFocus(inContent[0] || nodes.filter(function (n) { return !rail.contains(n); })[0] || nodes[0]);
  }
  function focusIsLost() {
    var active = cursor();
    if (!active) return true;
    return !layer && rail.contains(active) && Boolean(wantsContent || pendingFocus);
  }
  function move(dir) {
    var nodes = focusables();
    if (!nodes.length) return;
    var active = cursor();
    if (!active || nodes.indexOf(active) < 0) { focusFirst(); return; }
    var fromRail = !layer && rail.contains(active);
    // Depuis le menu latéral, Droite revient là où était le curseur.
    if (fromRail && dir === 'right' && lastContentFocus && root.contains(lastContentFocus) && lastContentFocus.offsetParent !== null) {
      setFocus(lastContentFocus);
      return;
    }
    // Haut/Bas ne passent jamais du menu latéral au contenu ni l'inverse : déplié,
    // le menu chevauche les cartes et la géométrie seule choisirait mal.
    var vertical = dir === 'up' || dir === 'down';
    var others = nodes.filter(function (n) {
      return n !== active && (layer || !vertical || rail.contains(n) === fromRail);
    });
    var index = pickNext(active.getBoundingClientRect(), others.map(function (n) { return n.getBoundingClientRect(); }), dir);
    if (index < 0) return;
    // Vers le menu latéral : toujours sur la rubrique en cours.
    if (!fromRail && !layer && rail.contains(others[index])) setFocus(navButtons[stack[0].name] || others[index]);
    else setFocus(others[index]);
  }

  // ---- Composants -----------------------------------------------------------
  function card(item, options) {
    options = options || {};
    var node = el('button', { class: 'tv-card' + (options.wide ? ' wide' : ''), 'data-f': true, 'data-fk': (options.prefix || 'c') + ':' + item.type + ':' + item.id + (options.suffix || '') });
    var image = options.wide ? (options.image || item.backdrop || item.poster) : (item.poster || item.backdrop);
    if (image) node.appendChild(el('img', { src: image, alt: '', loading: 'lazy', decoding: 'async' }));
    if (options.caption || !image) node.appendChild(el('div', { class: 'cap', text: options.caption || item.title }));
    if (options.onFocus) node.__tvFocus = function () { options.onFocus(item); };
    node.addEventListener('click', function () { (options.onSelect || openDetails)(item); });
    return node;
  }
  function row(title, itemsPromise, options) {
    var strip = el('div', { class: 'tv-strip' });
    var section = el('section', { class: 'tv-row', hidden: true }, [el('h2', { text: title }), strip]);
    var seq = renderSeq;
    Promise.resolve(itemsPromise).then(function (items) {
      if (seq !== renderSeq || !items || !items.length) return;
      items.slice(0, 24).forEach(function (entry) {
        var item = entry.item || entry;
        strip.appendChild(card(item, Object.assign({ prefix: title }, options || {}, entry.options || {})));
      });
      section.hidden = false;
      if (applyPending()) return;
      // Les rangées arrivent dans le désordre. Tant que personne n'a touché à la
      // télécommande, le curseur remonte sur la première carte de la page ;
      // ensuite on se contente de le garder à l'écran quand du contenu s'insère au-dessus.
      var here = cursor();
      if (focusIsLost() || (!userMoved && !layer && here && here.classList.contains('tv-card'))) focusFirst('.tv-card');
      else if (here && !layer) reveal(here);
    }).catch(function () { /* rangée ignorée : les autres restent utilisables */ });
    return section;
  }
  function metaLine(item, extra) {
    var meta = el('div', { class: 'tv-meta' });
    if (item.rating) meta.appendChild(el('span', { class: 'star', text: '★ ' + item.rating.toFixed(1) }));
    if (item.year) meta.appendChild(el('span', { text: item.year }));
    meta.appendChild(el('span', { class: 'pill', text: item.type === 'movie' ? 'Film' : 'Série' }));
    (extra || []).forEach(function (text) { if (text) meta.appendChild(el('span', { text: text })); });
    return meta;
  }

  // ---- Écrans ---------------------------------------------------------------
  function browseScreen(rowsFactory) {
    var backdrop = el('div', { class: 'tv-backdrop' });
    var title = el('h1');
    var metaHolder = el('div');
    var overview = el('div', { class: 'tv-overview' });
    var timer = null;
    function showHero(item) {
      clearTimeout(timer);
      timer = setTimeout(function () {
        title.textContent = item.title;
        metaHolder.textContent = '';
        metaHolder.appendChild(metaLine(item));
        overview.textContent = item.overview || '';
        backdrop.style.backgroundImage = item.backdrop ? 'url("' + item.backdrop + '")' : 'none';
      }, 140);
    }
    var inner = el('div', { class: 'tv-rows-inner' }, rowsFactory(showHero));
    return el('div', { class: 'tv-screen' }, [
      backdrop,
      el('div', { class: 'tv-hero' }, [title, metaHolder, overview]),
      el('div', { class: 'tv-rows' }, [inner]),
    ]);
  }
  function resumeRow(showHero) {
    var entries = resumeEntries();
    if (!entries.length) return null;
    var items = Promise.all(entries.map(function (entry) {
      return tmdb('/' + entry.type + '/' + entry.id, {}).then(function (data) {
        var item = normalize(Object.assign({ media_type: entry.type }, data));
        if (!item) return null;
        var label = entry.type === 'tv' && entry.season ? item.title + ' · S' + entry.season + ' É' + (entry.episode || 1) : item.title;
        return { item: item, options: { wide: true, caption: label, suffix: ':resume', onSelect: function () { play(watchUrl(item, entry.season, entry.episode)); } } };
      }).catch(function () { return null; });
    })).then(function (found) { return found.filter(Boolean); });
    return row('Reprendre la lecture', items, { onFocus: showHero });
  }
  var SCREENS = {
    home: function () {
      return browseScreen(function (showHero) {
        var opt = { onFocus: showHero };
        return [
          resumeRow(showHero),
          row('Tendances du moment', list('/trending/all/day', {}), opt),
          row('Films populaires', list('/movie/popular', { region: 'FR' }, 'movie'), opt),
          row('Séries populaires', list('/tv/popular', {}, 'tv'), opt),
          row('Au cinéma en ce moment', list('/movie/now_playing', { region: 'FR' }, 'movie'), opt),
          row('Films les mieux notés', list('/movie/top_rated', { region: 'FR' }, 'movie'), opt),
          row('Séries les mieux notées', list('/tv/top_rated', {}, 'tv'), opt),
          row('Animés', list('/discover/tv', { with_genres: '16', with_original_language: 'ja', sort_by: 'popularity.desc' }, 'tv'), opt),
        ];
      });
    },
    movies: function () {
      return browseScreen(function (showHero) {
        var opt = { onFocus: showHero };
        var genre = function (title, id) { return row(title, list('/discover/movie', { with_genres: id, sort_by: 'popularity.desc', region: 'FR' }, 'movie'), opt); };
        return [
          row('Films populaires', list('/movie/popular', { region: 'FR' }, 'movie'), opt),
          row('Tendances de la semaine', list('/trending/movie/week', {}, 'movie'), opt),
          genre('Action', '28'), genre('Comédie', '35'), genre('Science-fiction', '878'), genre('Thriller', '53'),
          genre('Horreur', '27'), genre('Animation', '16'), genre('Drame', '18'), genre('Famille', '10751'),
        ];
      });
    },
    series: function () {
      return browseScreen(function (showHero) {
        var opt = { onFocus: showHero };
        var genre = function (title, params) { return row(title, list('/discover/tv', Object.assign({ sort_by: 'popularity.desc' }, params), 'tv'), opt); };
        return [
          row('Séries populaires', list('/tv/popular', {}, 'tv'), opt),
          row('Tendances de la semaine', list('/trending/tv/week', {}, 'tv'), opt),
          genre('Drame', { with_genres: '18' }), genre('Comédie', { with_genres: '35' }), genre('Crime', { with_genres: '80' }),
          genre('Science-fiction et fantastique', { with_genres: '10765' }), genre('Animés', { with_genres: '16', with_original_language: 'ja' }),
          genre('Documentaires', { with_genres: '99' }),
        ];
      });
    },
    details: function (entry) {
      var backdrop = el('div', { class: 'tv-backdrop', style: 'height:100vh;opacity:.42' });
      var body = el('div', { class: 'tv-scroll-inner', style: 'padding-top:0' });
      var screen = el('div', { class: 'tv-screen' }, [backdrop, el('div', { class: 'tv-scroll', style: 'top:0' }, [body])]);
      var seq = renderSeq;
      var shownSeason = 0;
      tmdb('/' + entry.type + '/' + entry.id, { append_to_response: 'recommendations' }).then(function (data) {
        if (seq !== renderSeq) return;
        var item = normalize(Object.assign({ media_type: entry.type }, data)) || { id: entry.id, type: entry.type, title: data.title || data.name || '', overview: data.overview || '', backdrop: '', poster: '', year: '', rating: 0 };
        if (item.backdrop) backdrop.style.backgroundImage = 'url("' + item.backdrop + '")';
        var runtime = data.runtime ? Math.floor(data.runtime / 60) + ' h ' + String(data.runtime % 60).padStart(2, '0') : '';
        var seasons = (data.seasons || []).filter(function (s) { return s.season_number > 0 && s.episode_count > 0; });
        var genres = (data.genres || []).slice(0, 3).map(function (g) { return g.name; }).join(' · ');
        var resume = resumeEntries().filter(function (r) { return r.type === entry.type && r.id === Number(entry.id); })[0];
        var actions = el('div', { class: 'tv-actions' });
        var playLabel = entry.type === 'movie' ? '▶  Lecture' : (resume && resume.season ? '▶  Reprendre S' + resume.season + ' É' + (resume.episode || 1) : '▶  Lecture · S1 É1');
        actions.appendChild(el('button', { class: 'tv-btn primary', 'data-f': true, 'data-fk': 'play', text: playLabel, on: { click: function () { play(watchUrl(item, resume && resume.season, resume && resume.episode)); } } }));
        body.appendChild(el('div', { class: 'tv-detail' }, [
          el('h1', { text: item.title }),
          metaLine(item, [runtime, seasons.length ? seasons.length + (seasons.length > 1 ? ' saisons' : ' saison') : '', genres]),
          data.tagline ? el('div', { class: 'tv-note', style: 'margin:0 0 1vh;font-style:italic', text: data.tagline }) : null,
          el('div', { class: 'tv-overview', text: item.overview || 'Pas de résumé disponible.' }),
          actions,
        ]));
        if (seasons.length) {
          var chips = el('div', { class: 'tv-strip tv-chipline' });
          var episodes = el('div');
          var showSeason = function (season) {
            Array.prototype.forEach.call(chips.children, function (chip) { chip.classList.toggle('current', chip.getAttribute('data-season') === String(season.season_number)); });
            episodes.textContent = '';
            shownSeason = season.season_number;
            var stillShown = function () { return seq === renderSeq && shownSeason === season.season_number; };
            var strip = el('div', { class: 'tv-strip', style: 'padding-left:.8vh' });
            episodes.appendChild(el('section', { class: 'tv-row' }, [strip]));
            tmdb('/tv/' + entry.id + '/season/' + season.season_number, {}).then(function (detail) {
              if (!stillShown()) return;
              (detail.episodes || []).forEach(function (ep) {
                strip.appendChild(card(item, {
                  wide: true, prefix: 'ep', suffix: ':' + season.season_number + ':' + ep.episode_number,
                  image: ep.still_path ? IMG + 'w300' + ep.still_path : item.backdrop,
                  caption: 'É' + ep.episode_number + ' · ' + (ep.name || ''),
                  onSelect: function () { play(watchUrl(item, season.season_number, ep.episode_number)); },
                }));
              });
              applyPending();
            }).catch(function () {
              if (stillShown()) episodes.appendChild(el('div', { class: 'tv-note', text: 'Épisodes indisponibles pour le moment.' }));
            });
          };
          seasons.forEach(function (season) {
            chips.appendChild(el('button', { class: 'tv-chip', 'data-f': true, 'data-fk': 'season:' + season.season_number, 'data-season': season.season_number, text: season.name || 'Saison ' + season.season_number, on: { click: function () { entry.season = season.season_number; showSeason(season); } } }));
          });
          body.appendChild(el('div', null, [chips, episodes]));
          var wantedSeason = entry.season || (resume && resume.season);
          showSeason(seasons.filter(function (s) { return s.season_number === wantedSeason; })[0] || seasons[0]);
        }
        var similar = ((data.recommendations && data.recommendations.results) || []).map(function (r) { return normalize(r, entry.type); }).filter(Boolean);
        if (similar.length) {
          var simRow = row('À voir aussi', similar, { prefix: 'sim' });
          simRow.querySelector('h2').style.marginLeft = '0';
          simRow.querySelector('.tv-strip').style.paddingLeft = '.8vh';
          body.appendChild(simRow);
        }
        if (!applyPending()) focusFirst('.tv-btn');
      }).catch(function (err) {
        if (seq !== renderSeq) return;
        body.appendChild(el('div', { class: 'tv-detail' }, [el('h1', { text: 'Fiche indisponible' }), el('div', { class: 'tv-note', text: err.message })]));
      });
      return screen;
    },
    live: function (entry) {
      var chips = el('div', { class: 'tv-strip tv-chipline' });
      var grid = el('div', { class: 'tv-grid tiles' });
      var note = el('div', { class: 'tv-note', text: 'Chargement des chaînes…' });
      var inner = el('div', { class: 'tv-scroll-inner' }, [note, grid]);
      var seq = renderSeq;
      var page = el('div', { class: 'tv-page' }, [el('h1', { text: 'TV en direct' }), chips, el('div', { class: 'tv-scroll', style: 'top:21vh' }, [inner])]);
      function showCatalog(catalog) {
        entry.catalog = catalog.id;
        Array.prototype.forEach.call(chips.children, function (chip) { chip.classList.toggle('current', chip.getAttribute('data-id') === catalog.id); });
        grid.textContent = '';
        note.textContent = 'Chargement…';
        inner.style.transform = '';
        siteApi('/api/livetv/catalog/tv/' + encodeURIComponent(catalog.id)).then(function (data) {
          if (seq !== renderSeq || entry.catalog !== catalog.id) return;
          note.textContent = (data.metas || []).length ? '' : 'Aucune chaîne dans cette catégorie.';
          (data.metas || []).forEach(function (channel) {
            grid.appendChild(el('button', { class: 'tv-tile', 'data-f': true, 'data-fk': 'ch:' + channel.id, text: channel.name, on: { click: function () { openChannel(channel); } } }));
          });
          applyPending();
        }).catch(function (err) { if (seq === renderSeq && entry.catalog === catalog.id) note.textContent = err.message; });
      }
      siteApi('/api/livetv/manifest').then(function (manifest) {
        if (seq !== renderSeq) return;
        var catalogs = (manifest.catalogs || []).filter(function (c) { return /^northlive_/.test(c.id); });
        if (!catalogs.length) { note.textContent = 'Aucune chaîne disponible pour le moment.'; return; }
        catalogs.forEach(function (catalog) {
          chips.appendChild(el('button', { class: 'tv-chip', 'data-f': true, 'data-fk': 'cat:' + catalog.id, 'data-id': catalog.id, text: String(catalog.name || catalog.id).replace(/^northlive[ _-]*/i, ''), on: { click: function () { showCatalog(catalog); } } }));
        });
        showCatalog(catalogs.filter(function (c) { return c.id === entry.catalog; })[0] || catalogs[0]);
        if (focusIsLost()) focusFirst('.tv-chip');
      }).catch(function (err) { note.textContent = err.message; });
      return el('div', { class: 'tv-screen' }, [page]);
    },
    search: function (entry) {
      var query = entry.query || '';
      var queryBox = el('div', { class: 'tv-query' });
      var grid = el('div', { class: 'tv-grid' });
      var note = el('div', { class: 'tv-note' });
      var inner = el('div', { class: 'tv-scroll-inner', style: 'padding-left:1vh' }, [note, grid]);
      var timer = null;
      var seq = renderSeq;
      function run() {
        entry.query = query;
        queryBox.textContent = query || (PHONE_REMOTE ? 'Tape un titre, ou écris-le sur ton téléphone' : 'Choisis les lettres du titre');
        queryBox.classList.toggle('empty', !query);
        clearTimeout(timer);
        if (query.trim().length < 2) { grid.textContent = ''; note.textContent = ''; return; }
        var asked = query;
        timer = setTimeout(function () {
          list('/search/multi', { query: asked.trim(), include_adult: 'false' }).then(function (items) {
            if (seq !== renderSeq || query !== asked) return;
            grid.textContent = '';
            inner.style.transform = '';
            note.textContent = items.length ? '' : 'Aucun résultat pour « ' + asked.trim() + ' ».';
            items.slice().sort(function (a, b) { return b.votes - a.votes; })
              .forEach(function (item) { grid.appendChild(card(item, { prefix: 'res', caption: item.title })); });
            applyPending();
          }).catch(function (err) { note.textContent = err.message; });
        }, 320);
      }
      var keys = el('div', { class: 'tv-keys' });
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('').forEach(function (letter) {
        keys.appendChild(el('button', { class: 'tv-key', 'data-f': true, 'data-fk': 'k:' + letter, text: letter, on: { click: function () { query += letter.toLowerCase(); run(); } } }));
      });
      [['Espace', function () { query += ' '; }], ['Effacer', function () { query = query.slice(0, -1); }], ['Vider', function () { query = ''; }]].forEach(function (pair) {
        keys.appendChild(el('button', { class: 'tv-key wide', 'data-f': true, 'data-fk': 'k:' + pair[0], text: pair[0], on: { click: function () { pair[1](); run(); } } }));
      });
      screenApi = {
        getQuery: function () { return query; },
        setQuery: function (text, submit) {
          query = String(text || '');
          run();
          if (!submit) return;
          setTimeout(function () {
            if (seq !== renderSeq || layer || !grid.isConnected) return;
            var first = grid.querySelector('[data-f]');
            if (first) setFocus(first);
          }, 1100);
        },
      };
      run();
      return el('div', { class: 'tv-screen' }, [el('div', { class: 'tv-page' }, [
        el('h1', { text: 'Recherche' }),
        el('div', { class: 'tv-search' }, [el('div', null, [queryBox, keys]), el('div', { class: 'tv-results' }, [el('div', { class: 'tv-scroll', style: 'top:0' }, [inner])])]),
      ])]);
    },
    settings: function () {
      var info = el('div', { class: 'tv-note' });
      var actions = el('div', { class: 'tv-actions', style: 'flex-direction:column;align-items:flex-start' });
      var autoBtn = el('button', { class: 'tv-btn', 'data-f': true, 'data-fk': 'auto' });
      function renderAuto(on) { autoBtn.textContent = 'Lancer ' + APP + ' en mode TV au démarrage du PC : ' + (on ? 'oui' : 'non'); autoBtn.setAttribute('data-on', on ? '1' : '0'); }
      renderAuto(false);
      autoBtn.addEventListener('click', function () {
        if (!bridge) return;
        bridge.setAutoStart(autoBtn.getAttribute('data-on') !== '1').then(renderAuto).catch(function () { info.textContent = 'Réglage impossible sur cet ordinateur.'; });
      });
      // Appli de bureau : téléphone en télécommande, lancement au démarrage,
      // retour au mode normal. Appli Android TV (STANDALONE) : rien de tout ça,
      // la télécommande de la télé suffit et il n'y a pas d'autre mode.
      if (PHONE_REMOTE) actions.appendChild(el('button', { class: 'tv-btn primary', 'data-f': true, 'data-fk': 'pair', text: 'Afficher le QR code de la télécommande', on: { click: showPairing } }));
      if (!STANDALONE) {
        actions.appendChild(autoBtn);
        actions.appendChild(el('button', { class: 'tv-btn', 'data-f': true, 'data-fk': 'exit', text: 'Quitter le mode TV', on: { click: function () { if (bridge) bridge.exit(); } } }));
      }
      actions.appendChild(el('button', { class: 'tv-btn' + (STANDALONE ? ' primary' : ''), 'data-f': true, 'data-fk': 'quit', text: 'Fermer ' + APP, on: { click: function () { if (bridge) bridge.quit(); } } }));
      if (bridge) {
        bridge.info().then(function (data) {
          renderAuto(Boolean(data.autoStart));
          info.textContent = APP + ' ' + (data.version || '') + (PHONE_REMOTE ? ' · télécommande : ' + (data.remoteUrl || 'indisponible') : '');
        }).catch(function () { info.textContent = 'Informations indisponibles.'; });
      }
      return el('div', { class: 'tv-screen' }, [el('div', { class: 'tv-page' }, [
        el('h1', { text: 'Réglages' }),
        el('div', { class: 'tv-note', text: STANDALONE
          ? 'Flèches de la télécommande pour se déplacer, OK pour valider, Retour pour revenir en arrière.'
          : 'Flèches pour se déplacer, OK pour valider, Retour pour revenir. F9 bascule entre le mode TV et le mode normal.' }),
        actions, info,
      ])]);
    },
  };

  // ---- Calques --------------------------------------------------------------
  function closeLayer() {
    if (!layer) return;
    var back = layer.__returnFocus;
    layer.remove();
    layer = null;
    if (back && document.contains(back) && back !== document.body && !(wantsContent && rail.contains(back))) setFocus(back);
    else focusFirst();
  }
  function openLayer(node) {
    var returnTo = layer ? layer.__returnFocus : cursor();
    if (layer) { layer.remove(); layer = null; }
    node.__returnFocus = returnTo;
    layer = node;
    root.appendChild(node);
    focusFirst();
  }
  function showPairing() {
    var qr = el('img', { class: 'qr', alt: 'QR code de la télécommande' });
    var address = el('code', { text: '…' });
    var dialog = el('div', { class: 'tv-dialog' }, [qr, el('div', null, [
      el('h2', { text: 'Ton téléphone devient la télécommande' }),
      el('ol', null, [
        el('li', { text: 'Connecte ton téléphone au même Wi-Fi que cet ordinateur.' }),
        el('li', { text: 'Ouvre l’appareil photo et vise le QR code.' }),
        el('li', { text: 'Touche le lien : la télécommande s’ouvre.' }),
      ]),
      el('div', { class: 'tv-note', style: 'margin-top:0' }, ['Ou tape cette adresse dans le navigateur du téléphone : ', address]),
      el('div', { class: 'tv-note', style: 'margin-top:0;font-size:1.9vh' , text: 'Si la page ne s’ouvre pas : au premier lancement, Windows demande d’autoriser ' + APP + ' sur le réseau — réponds « Autoriser ».' }),
      el('div', { class: 'tv-note', style: 'margin-top:0;font-size:1.9vh', text: 'Wi-Fi de résidence, d’hôtel ou d’école : les appareils n’y communiquent pas entre eux. Active le « Point d’accès sans fil mobile » de Windows, connecte ton téléphone dessus, puis rouvre ce QR code.' }),
      el('button', { class: 'tv-btn primary', 'data-f': true, text: 'C’est bon', on: { click: closeLayer } }),
    ])]);
    openLayer(el('div', { class: 'tv-layer' }, [dialog]));
    if (!bridge) { address.textContent = 'télécommande indisponible'; return; }
    bridge.info().then(function (data) {
      if (data.qr) qr.src = data.qr;
      address.textContent = data.remoteUrl || 'télécommande indisponible';
    }).catch(function () { address.textContent = 'télécommande indisponible'; });
  }
  function openChannel(channel) {
    var holder = el('div', { class: 'tv-live' });
    var name = el('div', { class: 'name', text: channel.name });
    // Bouton invisible : garde le curseur dans le calque (Retour le ferme).
    var anchor = el('button', { 'data-f': true, 'aria-label': 'Chaîne en cours', style: 'position:absolute;opacity:0;width:1px;height:1px' });
    holder.appendChild(name);
    holder.appendChild(anchor);
    openLayer(holder);
    var hideName = setTimeout(function () { name.style.opacity = '0'; }, 5000);
    var showProblem = function (text) { clearTimeout(hideName); name.textContent = channel.name + ' — ' + text; name.style.opacity = '1'; };
    siteApi('/api/livetv/stream/tv/' + encodeURIComponent(channel.id)).then(function (data) {
      if (layer !== holder) return;
      var stream = (data.streams || []).filter(function (s) { return s && s._isEmbed && /^https:\/\//.test(s.url); })[0];
      if (!stream) { showProblem('flux indisponible'); return; }
      holder.insertBefore(el('iframe', { src: stream.url, allow: 'autoplay; fullscreen; encrypted-media', allowfullscreen: true, referrerpolicy: 'origin' }), name);
    }).catch(function (err) { if (layer === holder) showProblem(err.message); });
  }
  function openDetails(item) {
    saveFocusInEntry();
    stack.push({ name: 'details', type: item.type, id: item.id });
    render();
  }
  // Chaque écran retient son curseur : Retour y revient.
  function saveFocusInEntry() {
    var active = cursor();
    current().focus = (active && active.getAttribute('data-fk')) || '';
  }

  // ---- Rendu et navigation entre écrans ----------------------------------------
  function render() {
    if (layer) { layer.remove(); layer = null; }
    var entry = current();
    var factory = SCREENS[entry.name] || SCREENS.home;
    if (screenNode) screenNode.remove();
    screenApi = null;
    if (!pendingFocus) pendingFocus = entry.focus || '';
    wantsContent = true;
    userMoved = Boolean(pendingFocus);   // curseur mémorisé à restaurer : pas de replacement d'office
    lastContentFocus = null;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    clearMark();
    renderSeq += 1;
    var seq = renderSeq;
    screenNode = factory(entry);
    main.insertBefore(screenNode, main.firstChild);
    var top = stack[0].name;
    Object.keys(navButtons).forEach(function (name) { navButtons[name].classList.toggle('current', name === top); });
    setTimeout(function () { if (seq === renderSeq && focusIsLost()) focusFirst(); }, 60);
    // Le curseur mémorisé n'attend pas indéfiniment un élément disparu.
    setTimeout(function () {
      if (seq !== renderSeq) return;
      pendingFocus = '';
      if (focusIsLost()) focusFirst();
    }, 4000);
  }
  function goTo(name) {
    pendingFocus = '';
    stack = [{ name: SCREENS[name] ? name : 'home' }];
    render();
  }
  function goBack() {
    if (layer) return closeLayer();
    if (stack.length > 1) {
      stack.pop();
      pendingFocus = '';
      return render();
    }
    if (!rail.contains(cursor())) {
      wantsContent = false;
      pendingFocus = '';
      return setFocus(navButtons[stack[0].name]);
    }
    if (stack[0].name !== 'home') return goTo('home');
    // Android TV : Retour sur le menu de l'accueil ferme l'appli, comme partout sur une télé.
    if (STANDALONE && bridge) bridge.quit();
    return undefined;
  }
  function handleKey(key) {
    wake();
    userMoved = true;
    if (key === 'up' || key === 'down' || key === 'left' || key === 'right') {
      // L'utilisateur a pris la main : le contenu qui arrive ne déplace plus le curseur.
      if (!layer) { wantsContent = false; pendingFocus = ''; }
      return move(key);
    }
    if (key === 'ok') {
      var active = cursor();
      if (active && active.hasAttribute('data-f')) active.click();
      else focusFirst();
      return undefined;
    }
    if (key === 'back') return goBack();
    if (key === 'home') return goTo('home');
    if (key === 'menu') {
      if (layer) closeLayer();
      wantsContent = false;
      pendingFocus = '';
      return setFocus(navButtons[stack[0].name]);
    }
    return undefined;
  }
  // Chaîne en direct à l'écran : lecture, son et avance partent vers l'iframe
  // du lecteur (processus principal), seuls Retour / Accueil / Menu restent ici.
  function watchingLive() { return Boolean(layer && layer.classList.contains('tv-live')); }
  window.__mewflixTvKey = function (key) {
    if (watchingLive() && key !== 'back' && key !== 'home' && key !== 'menu') { wake(); return 'no-video'; }
    handleKey(key);
    return 'done';
  };
  window.__mewflixTvNav = function (name) { goTo(name); };
  window.__mewflixTvText = function (text, submit) {
    if (current().name !== 'search' || layer) { pendingFocus = ''; stack = [{ name: 'search', query: '' }]; render(); }
    if (screenApi) screenApi.setQuery(text, submit);
  };

  var KEYMAP = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'ok', Escape: 'back', Backspace: 'back', BrowserBack: 'back', BrowserHome: 'home', ContextMenu: 'menu' };
  window.addEventListener('keydown', function (event) {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    var key = KEYMAP[event.key];
    var typing = screenApi && current().name === 'search' && !layer;
    if (typing && !key && event.key.length === 1) {
      event.preventDefault();
      event.stopImmediatePropagation();
      screenApi.setQuery(screenApi.getQuery() + event.key);
      return;
    }
    if (typing && event.key === 'Backspace' && screenApi.getQuery().length) {
      event.preventDefault();
      event.stopImmediatePropagation();
      screenApi.setQuery(screenApi.getQuery().slice(0, -1));
      return;
    }
    // Tab déplacerait le focus du navigateur sans passer par le curseur.
    if (event.key === 'Tab') { event.preventDefault(); return; }
    if (!key) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    handleKey(key);
  }, true);

  // Souris : survoler une carte la sélectionne ; curseur masqué au repos.
  var idleTimer = null;
  function wake() {
    root.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { root.classList.add('idle'); }, 3000);
  }
  root.addEventListener('mousemove', function (event) {
    wake();
    var target = event.target && event.target.closest ? event.target.closest('[data-f]') : null;
    if (target) userMoved = true;
    if (target && target !== cursor() && scope().contains(target)) {
      target.focus({ preventScroll: true });
      markFocus(target);
    }
  });

  function tick() {
    var now = new Date();
    clock.textContent = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  }

  var mounted = false;
  function mount() {
    if (mounted || !document.body) return;
    mounted = true;
    document.documentElement.classList.add('mewflix-tv');
    var style = document.createElement('style');
    style.id = 'mewflix-tv-style';
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
    rail.appendChild(el('div', { class: 'tv-logo' }, [CFG.icon ? el('img', { src: CFG.icon, alt: '' }) : null, el('span', { text: APP })]));
    NAV.forEach(function (pair) {
      var button = el('button', { class: 'tv-nav', 'data-f': true, 'data-fk': 'nav:' + pair[0], on: { click: function () { goTo(pair[0]); } } }, [icon(pair[0]), el('span', { text: pair[1] })]);
      navButtons[pair[0]] = button;
      rail.appendChild(button);
    });
    // Bouton « off » toujours visible, en bas du menu : retour au MEWFLIX normal.
    rail.appendChild(el('button', {
      class: 'tv-nav tv-exit', 'data-f': true, 'data-fk': 'nav:exit',
      on: { click: function () { if (bridge) { if (STANDALONE) bridge.quit(); else bridge.exit(); } } },
    }, [icon('exit'), el('span', { text: STANDALONE ? 'Fermer ' + APP : 'Quitter le mode TV' })]));
    main.appendChild(clock);
    root.appendChild(rail);
    root.appendChild(main);
    document.body.appendChild(root);
    tick();
    setInterval(tick, 20000);
    wake();

    var saved = readJson(sessionStorage, STATE_KEY, null);
    if (saved && Array.isArray(saved.stack) && saved.stack.length) {
      stack = saved.stack.filter(function (entry) { return entry && SCREENS[entry.name]; });
      if (!stack.length) stack = [{ name: 'home' }];
      pendingFocus = saved.focus || '';
    }
    render();
    // Première ouverture de la session : on présente la télécommande.
    if (PHONE_REMOTE && !sessionStorage.getItem('mewflix_tv_paired')) {
      try { sessionStorage.setItem('mewflix_tv_paired', '1'); } catch (e) { /* stockage fermé */ }
      setTimeout(showPairing, 600);
    }
  }
  // Le site est masqué dès le premier instant, l'interface se monte quand <body> existe.
  // (Sur une page non HTML, la racine n'existe pas encore à cet instant.)
  if (document.documentElement) document.documentElement.classList.add('mewflix-tv');
  // Montage dès que <body> existe, sans attendre la fin du chargement : sur
  // certaines pages le document ne la signale jamais (flux resté ouvert).
  if (document.body) {
    mount();
  } else {
    var bodyWatch = new MutationObserver(function () {
      if (!document.body) return;
      bodyWatch.disconnect();
      mount();
    });
    bodyWatch.observe(document, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  }
})();
