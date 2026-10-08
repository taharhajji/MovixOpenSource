'use strict';

/**
 * Retouches du site injectées avant tout script de la page, partagées entre
 * l'app de bureau (bridge-runtime.js) et l'app iOS/Android (générées dans
 * app/src/injection/site-tweaks-source.ts par apple/ios/apply-branding.mjs).
 *
 * Chaque retouche est indépendante et gardée par une option :
 *  - localVip         : statut VIP côté interface (clé `is_vip` épinglée) ;
 *  - hideSiteBranding : logo/intro cachés, « MOVIX » remplacé par le nom de l'app ;
 *  - adPopupAutoExpr  : expression JS évaluée dans la page ; vraie, le popup
 *                       « voir une pub » passe en mode auto (réglage du site) ;
 *  - swiftfluxSource  : 'last' relègue la source SwiftFlux (la seule dont la
 *                       lecture exige une vérification Turnstile côté API) en
 *                       fin de priorité, 'off' la désactive, 'keep' ne touche
 *                       à rien.
 *
 * Le code produit est du JS ES5 autonome (pas de dépendance au pont natif,
 * sauf ce que `adPopupAutoExpr` référence).
 */

const DEFAULT_TOP_LEVEL_ORDER = [
  'nexus_hls', 'swiftflux', 'bravo', 'mp4', 'darkino',
  'fstream', 'omega', 'wiflix', 'j1f', 'swiftflow', 'viper', 'coflix',
  'custom', 'frembed', 'vox', 'kisskh', 'vostfr',
];
const DEFAULT_HOSTER_ORDER = [
  'voe', 'vidmoly', 'vidzy', 'uqload', 'sibnet', 'veev', 'doodstream',
  'lulustream', 'vidara',
  'seekstreaming', 'smoothpre', 'minochinos', 'darkibox',
  'supervideo', 'dropload', 'oneupload', 'fsvid',
];
const LANGUAGE_IDS = ['vf', 'vostfr', 'vj', 'va', 'vkr', 'vcn'];
const DEFAULT_ANIME_HOSTER_ORDER = ['vidmoly', 'sibnet', 'smoothpre', 'seekstreaming', 'minochinos'];

function buildLocalVip() {
  return `
  // --- Statut VIP local ------------------------------------------------------------
  // Le site lit son statut VIP dans localStorage ('is_vip' === 'true') et le
  // révoque dès que la vérification serveur échoue ou qu'aucun code n'est
  // enregistré. On épingle la clé au niveau du prototype Storage : toute
  // lecture rend 'true', toute écriture ou suppression est ignorée. Ce que
  // l'API sert uniquement aux vrais codes (x-access-key) n'est pas concerné.
  (function pinLocalVip() {
    var KEY = 'is_vip';
    try {
      var proto = Storage.prototype;
      var getItem = proto.getItem, setItem = proto.setItem, removeItem = proto.removeItem;
      var isLocal = function(storage) { try { return storage === window.localStorage; } catch (e) { return false; } };
      proto.getItem = function(key) {
        if (key === KEY && isLocal(this)) return 'true';
        return getItem.apply(this, arguments);
      };
      proto.setItem = function(key, value) {
        if (key === KEY && isLocal(this)) return setItem.call(this, KEY, 'true');
        return setItem.apply(this, arguments);
      };
      proto.removeItem = function(key) {
        if (key === KEY && isLocal(this)) return undefined;
        return removeItem.apply(this, arguments);
      };
      setItem.call(window.localStorage, KEY, 'true');
      window.__ORBIT_LOCAL_VIP__ = true;
    } catch (e) {}
  })();
`;
}

function buildHideBranding() {
  return `
  // --- Marque du site masquée dans la page -------------------------------------
  // Images de logo et intro animée cachées par CSS ; texte « MOVIX » du header
  // et du footer remplacé par le nom de l'app, rejoué dans le callback du
  // MutationObserver (microtâche, avant le rendu : aucun flash).
  (function hideSiteBranding() {
    // Le logo du site est tantôt un texte « MOVIX », tantôt un SVG
    // (span[data-movix-logo] > svg[aria-label="Movix"]) : les deux sont traités.
    var CSS = [
      'img[src*="/movix"], img[alt*="movix" i], .bb-logo { display: none !important; }',
      '[data-movix-logo], svg[aria-label*="movix" i] { display: none !important; }',
      '.orbit-brand { display: inline-flex; align-items: center; font-weight: 800; letter-spacing: 0.08em; font-size: 1.5rem; line-height: 1; color: ' + ACCENT + '; }',
    ].join('\\n');
    var BRAND_RE = /^(\\s*)movix(\\s*)$/i;
    var BRAND_ANY_RE = /movix/gi;
    var scheduled = false;

    function addStyle() {
      if (document.getElementById('orbit-site-branding')) return true;
      var parent = document.head || document.documentElement;
      if (!parent) return false;
      var style = document.createElement('style');
      style.id = 'orbit-site-branding';
      style.textContent = CSS;
      parent.appendChild(style);
      return true;
    }

    function scrubTextNodes(root) {
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      var node;
      while ((node = walker.nextNode())) {
        var value = node.nodeValue || '';
        var match = BRAND_RE.exec(value);
        if (match) {
          // Logo texte seul : respecte la casse (MOVIX → MEWFLIX) et prend la couleur accent.
          var original = value.trim();
          var replacement = original === original.toUpperCase() ? APP_NAME.toUpperCase() : APP_NAME;
          node.nodeValue = match[1] + replacement + match[2];
          var el = node.parentElement;
          if (el && /text-red/.test(el.className || '')) el.style.color = ACCENT;
        } else if (BRAND_ANY_RE.test(value)) {
          // Phrases du pied de page (« À propos de Movix », « © 2026 Movix ») : marque remplacée dans le texte.
          BRAND_ANY_RE.lastIndex = 0;
          node.nodeValue = value.replace(BRAND_ANY_RE, APP_NAME);
        }
        BRAND_ANY_RE.lastIndex = 0;
      }
    }

    // Le titre du document est réécrit par le site à chaque page (« Accueil -
    // Movix ») : on y remplace la marque aussi.
    function scrubTitle() {
      try {
        var t = document.title;
        if (/movix/i.test(t)) document.title = t.replace(/movix/gi, APP_NAME);
      } catch (e) {}
    }

    // Logo SVG : le lien du logo reçoit le nom de l'app en texte, une seule fois.
    function placeWordmark() {
      var links = document.querySelectorAll('header a[href="/"], footer a[href="/"]');
      for (var i = 0; i < links.length; i++) {
        var link = links[i];
        if (!link.querySelector('[data-movix-logo], svg[aria-label*="movix" i]')) continue;
        if (link.querySelector('.orbit-brand')) continue;
        var mark = document.createElement('span');
        mark.className = 'orbit-brand';
        mark.textContent = APP_NAME.toUpperCase();
        link.appendChild(mark);
      }
    }

    function scrub() {
      addStyle();
      scrubTitle();
      placeWordmark();
      var roots = document.querySelectorAll('header, footer');
      for (var i = 0; i < roots.length; i++) scrubTextNodes(roots[i]);
    }

    function schedule() {
      if (scheduled) return;
      scheduled = true;
      try { scrub(); } finally { scheduled = false; }
    }

    if (!addStyle()) {
      new MutationObserver(function(_m, observer) {
        if (addStyle()) observer.disconnect();
      }).observe(document, { childList: true });
    }
    var start = function() {
      scrub();
      new MutationObserver(schedule).observe(document.documentElement, {
        childList: true, subtree: true, characterData: true
      });
    };
    if (document.documentElement) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  })();
`;
}

function buildAdPopupAuto(expr, storagePrefix) {
  return `
  // --- Popup « voir une pub avant de regarder » --------------------------------
  // Le site propose un mode « auto » pour ce popup (réglage Intermission) :
  // rien n'est affiché, le lien pub est ouvert en arrière-plan (neutralisé par
  // l'app) et la lecture démarre. Forcé avant que le site ne lise le réglage ;
  // le réglage précédent est mémorisé et restauré si la condition retombe.
  (function syncAdPopupMode() {
    var KEY = 'settings_ad_popup_mode';
    var MARK = ${JSON.stringify(`${storagePrefix}:ad_popup_forced`)};
    try {
      var forced = !!(${expr});
      var current = localStorage.getItem(KEY);
      if (forced) {
        if (current !== 'auto') {
          localStorage.setItem(MARK, current === null ? '' : current);
          localStorage.setItem(KEY, 'auto');
        }
      } else if (localStorage.getItem(MARK) !== null) {
        var previous = localStorage.getItem(MARK);
        if (previous) localStorage.setItem(KEY, previous);
        else localStorage.removeItem(KEY);
        localStorage.removeItem(MARK);
      }
    } catch (e) {}
  })();
`;
}

function buildSwiftfluxDemotion(mode) {
  return `
  // --- Source SwiftFlux reléguée ------------------------------------------------
  // La lecture SwiftFlux passe par une vérification Turnstile (« je ne suis pas
  // un robot ») exigée par l'API, même pour les admins. Pour que les films
  // démarrent sans cette étape, la source est placée en dernière position de
  // l'ordre de priorité du site (réglage « Sources »), ${mode === 'off' ? 'et désactivée' : 'mais reste disponible si rien d’autre n’existe'}.
  (function demoteSwiftflux() {
    var KEY = 'settings_source_priority_prefs';
    var MODE = ${JSON.stringify(mode)};
    var TOP = ${JSON.stringify(DEFAULT_TOP_LEVEL_ORDER)};
    var HOSTERS = ${JSON.stringify(DEFAULT_HOSTER_ORDER)};
    var LANGS = ${JSON.stringify(LANGUAGE_IDS)};
    var ANIME_HOSTERS = ${JSON.stringify(DEFAULT_ANIME_HOSTER_ORDER)};
    function defaults() {
      return {
        version: 4,
        categories: {
          moviesTv: {
            sourceOrder: TOP.map(function(id) { return { id: id, enabled: true }; }),
            hosterOrder: HOSTERS.slice(),
            languageOrder: LANGS.map(function(id) { return { id: id, enabled: id === 'vf' || id === 'vostfr' }; }),
            overrides: {}, pinnedSource: null, pinnedHoster: null, pinnedLanguage: null
          },
          anime: {
            languageOrder: LANGS.map(function(id) { return { id: id, enabled: true }; }),
            hosterOrder: ANIME_HOSTERS.slice(),
            overrides: {}, pinnedLanguage: null, pinnedHoster: null
          }
        },
        customHosters: [], patternOverrides: {}, updatedAt: Date.now()
      };
    }
    try {
      var raw = localStorage.getItem(KEY);
      var prefs = null;
      try { prefs = raw ? JSON.parse(raw) : null; } catch (e) { prefs = null; }
      // Un ancien schéma est laissé au site, qui le migre ; on repassera.
      if (prefs && prefs.version && prefs.version !== 4) return;
      var valid = prefs && prefs.version === 4 && prefs.categories && prefs.categories.moviesTv
        && Array.isArray(prefs.categories.moviesTv.sourceOrder)
        && prefs.categories.anime && Array.isArray(prefs.categories.anime.languageOrder);
      if (!valid) prefs = defaults();
      var tv = prefs.categories.moviesTv;
      var order = tv.sourceOrder;
      var idx = -1;
      for (var i = 0; i < order.length; i++) if (order[i] && order[i].id === 'swiftflux') idx = i;
      var wantEnabled = MODE !== 'off';
      var alreadyLast = idx === order.length - 1 && order[idx].enabled === wantEnabled;
      var pinned = tv.pinnedSource && tv.pinnedSource.id === 'swiftflux';
      if (alreadyLast && !pinned && raw) return;
      var entry = idx >= 0 ? order.splice(idx, 1)[0] : { id: 'swiftflux', enabled: true };
      entry.enabled = wantEnabled;
      order.push(entry);
      if (pinned) tv.pinnedSource = null;
      prefs.updatedAt = Date.now();
      localStorage.setItem(KEY, JSON.stringify(prefs));
      // Si le dernier lecteur mémorisé était SwiftFlux, il serait repris en
      // priorité (réglage « reprendre le dernier lecteur », clé playerLastId).
      try {
        var last = localStorage.getItem('playerLastId');
        if (last && /swiftflux/i.test(last)) localStorage.removeItem('playerLastId');
      } catch (e) {}
    } catch (e) {}
  })();
`;
}

function buildCommunityLinksHiding() {
  return `
  // --- Liens communauté / développeurs masqués -----------------------------------
  // Telegram, code source GitHub, liste des miroirs, bloc « Rejoignez la
  // communauté », colonne « Communauté » du pied de page et section « Conçu
  // avec » (technologies). Sélecteurs sur les href et la structure, rejoués
  // par le navigateur lui-même (CSS), donc valables après chaque re-rendu.
  (function hideCommunityLinks() {
    var CSS = [
      'a[href*="t.me/"], a[href*="telegram"], a[href*="github.com"], a[href*="movix.online"] { display: none !important; }',
      'li:has(> a[href*="t.me/"]), li:has(> a[href*="telegram"]), li:has(> a[href*="github.com"]), li:has(> a[href*="movix.online"]) { display: none !important; }',
      'footer nav > div:has(a[href*="t.me/"]) { display: none !important; }',
      'section[aria-labelledby="footer-technologies"] { display: none !important; }',
      'div:has(> div.grid > a[href*="t.me/"]) { display: none !important; }',
      'a[href*="/extension"], li:has(> a[href*="/extension"]), a[href="/app"], li:has(> a[href="/app"]) { display: none !important; }',
      // Pied de page : après le copyright, les lignes « développé avec… » et crédits.
      'footer div.border-t > p:not(:first-child) { display: none !important; }',
    ].join('\\n');
    function addStyle() {
      if (document.getElementById('orbit-community-links')) return true;
      var parent = document.head || document.documentElement;
      if (!parent) return false;
      var style = document.createElement('style');
      style.id = 'orbit-community-links';
      style.textContent = CSS;
      parent.appendChild(style);
      return true;
    }
    if (!addStyle()) {
      new MutationObserver(function(_m, observer) {
        if (addStyle()) observer.disconnect();
      }).observe(document, { childList: true });
    }
  })();
`;
}

function buildIframeSandbox(exemptHosts) {
  return `
  // --- Lecteurs en iframe : bac à sable -------------------------------------------
  // Les lecteurs tiers (DoodStream, FStream, Wiflix…) ouvrent des popups
  // (window.open) ou redirigent la page parente (top.location) vers des régies.
  // Un iframe en bac à sable sans allow-popups ni allow-top-navigation en est
  // incapable, au niveau du navigateur. allow-scripts + allow-same-origin
  // laissent le lecteur fonctionner normalement. Les iframes du site lui-même
  // et quelques services (Turnstile, YouTube) sont exemptés.
  (function sandboxEmbeds() {
    if (typeof HTMLIFrameElement === 'undefined' || typeof Element === 'undefined') return;
    var SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-presentation allow-orientation-lock allow-pointer-lock';
    var EXEMPT = ${JSON.stringify(exemptHosts)};
    var MARK = 'data-orbit-sandbox';
    function exempt(hostname) {
      for (var i = 0; i < EXEMPT.length; i++) {
        if (hostname === EXEMPT[i] || hostname.slice(-EXEMPT[i].length - 1) === '.' + EXEMPT[i]) return true;
      }
      return false;
    }
    function shouldSandbox(src) {
      try {
        var u = new URL(String(src || ''), location.href);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        if (u.origin === location.origin) return false;
        return !exempt(u.hostname);
      } catch (e) { return false; }
    }
    var rawSetAttribute = Element.prototype.setAttribute;
    var rawRemoveAttribute = Element.prototype.removeAttribute;
    function reconcile(frame, src) {
      if (shouldSandbox(src)) {
        if (!frame.hasAttribute('sandbox')) {
          rawSetAttribute.call(frame, 'sandbox', SANDBOX);
          rawSetAttribute.call(frame, MARK, '1');
        }
      } else if (frame.getAttribute(MARK) === '1') {
        rawRemoveAttribute.call(frame, 'sandbox');
        rawRemoveAttribute.call(frame, MARK);
      }
    }
    // src posé avant chargement : propriété et attribut interceptés.
    var desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
    if (desc && desc.set) {
      Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set: function(value) { reconcile(this, value); return desc.set.call(this, value); }
      });
    }
    Element.prototype.setAttribute = function(name, value) {
      if (this.tagName === 'IFRAME' && String(name).toLowerCase() === 'src') reconcile(this, value);
      return rawSetAttribute.apply(this, arguments);
    };
    // iframes insérés déjà chargés (innerHTML) : bac à sable puis rechargement.
    function sweep(root) {
      var frames = root.tagName === 'IFRAME' ? [root] : (root.querySelectorAll ? root.querySelectorAll('iframe') : []);
      for (var i = 0; i < frames.length; i++) {
        var f = frames[i];
        var src = f.getAttribute('src') || '';
        if (src && shouldSandbox(src) && !f.hasAttribute('sandbox')) {
          rawSetAttribute.call(f, 'sandbox', SANDBOX);
          rawSetAttribute.call(f, MARK, '1');
          rawSetAttribute.call(f, 'src', src);
        }
      }
    }
    function start() {
      sweep(document.documentElement);
      new MutationObserver(function(mutations) {
        for (var m = 0; m < mutations.length; m++) {
          var added = mutations[m].addedNodes;
          for (var n = 0; n < added.length; n++) if (added[n].nodeType === 1) sweep(added[n]);
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    }
    if (document.documentElement) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  })();
`;
}

function buildPopupNeutralizer(safeHosts) {
  return `
  // --- Popups vers l'extérieur neutralisés (version web, sans pont natif) -------
  // Les régies ouvrent leurs liens par window.open : hors du site et des hôtes
  // sûrs (support, réseaux), la page reçoit une fenêtre factice et rien ne
  // s'ouvre. Les flux « voir une pub » se valident sans pub.
  (function neutralizeExternalPopups() {
    var SAFE = ${JSON.stringify(safeHosts)};
    function safeHost(hostname) {
      hostname = String(hostname || '').toLowerCase();
      for (var i = 0; i < SAFE.length; i++) {
        if (hostname === SAFE[i] || hostname.slice(-SAFE[i].length - 1) === '.' + SAFE[i]) return true;
      }
      return false;
    }
    function external(url) {
      try {
        var absolute = new URL(String(url == null ? '' : url), location.href);
        return (absolute.protocol === 'http:' || absolute.protocol === 'https:')
          && absolute.origin !== location.origin && !safeHost(absolute.hostname) ? absolute : null;
      } catch (e) { return null; }
    }
    var nativeOpen = typeof window.open === 'function' ? window.open.bind(window) : null;
    window.open = function(url, target, features) {
      var absolute = external(url);
      if (absolute) {
        var fake = { closed: false, close: function() { fake.closed = true; }, focus: function() {}, blur: function() {},
          postMessage: function() {}, location: { href: absolute.href }, opener: null };
        return fake;
      }
      return nativeOpen ? nativeOpen(url, target, features) : null;
    };
    // Liens cliqués vers l'extérieur (régies posées en <a target="_blank">,
    // redirections au clic sur un lecteur) : ignorés, sauf hôtes sûrs.
    document.addEventListener('click', function(event) {
      var anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
      if (!anchor) return;
      if (external(anchor.getAttribute('href'))) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
    document.addEventListener('auxclick', function(event) {
      var anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
      if (anchor && external(anchor.getAttribute('href'))) event.preventDefault();
    }, true);
  })();
`;
}

/**
 * @param {object} options
 * @param {string} options.appName
 * @param {string[]|null} [options.popupSafeHosts]  hôtes externes autorisés par window.open ;
 *   fourni, les autres popups externes sont neutralisés (version web)
 * @param {string} [options.accent]
 * @param {boolean} [options.hideSiteBranding]
 * @param {boolean} [options.localVip]
 * @param {string} [options.adPopupAutoExpr]  expression JS ('true', 'false' ou dynamique)
 * @param {'last'|'off'|'keep'} [options.swiftfluxSource]
 * @param {string} [options.storagePrefix]
 * @returns {string} code JS à exécuter dans la page avant ses scripts
 */
function buildSiteTweaks({
  appName,
  accent = '#dbe6f6',
  hideSiteBranding = false,
  localVip = false,
  adPopupAutoExpr = null,
  swiftfluxSource = 'keep',
  storagePrefix = 'orbit_desktop',
  popupSafeHosts = null,
  hideCommunityLinks = hideSiteBranding,
  sandboxEmbeds = true,
  sandboxExemptHosts = ['challenges.cloudflare.com', 'youtube.com', 'youtube-nocookie.com', 'player.vimeo.com', 'accounts.google.com', 'discord.com'],
} = {}) {
  const parts = [];
  parts.push(`
(function() {
  'use strict';
  var APP_NAME = ${JSON.stringify(String(appName || 'MEWFLIX'))};
  var ACCENT = ${JSON.stringify(String(accent))};
`);
  if (localVip) parts.push(buildLocalVip());
  if (hideSiteBranding) parts.push(buildHideBranding());
  if (hideCommunityLinks) parts.push(buildCommunityLinksHiding());
  // Toujours inclus quand une expression est fournie, y compris 'false' : le
  // bloc restaure alors le réglage précédent s'il avait été forcé.
  if (adPopupAutoExpr != null) parts.push(buildAdPopupAuto(adPopupAutoExpr, storagePrefix));
  if (swiftfluxSource === 'last' || swiftfluxSource === 'off') parts.push(buildSwiftfluxDemotion(swiftfluxSource));
  if (Array.isArray(popupSafeHosts)) parts.push(buildPopupNeutralizer(popupSafeHosts));
  if (sandboxEmbeds) parts.push(buildIframeSandbox(sandboxExemptHosts));
  parts.push(`
})();
`);
  return parts.join('');
}

module.exports = { buildSiteTweaks, DEFAULT_TOP_LEVEL_ORDER };
