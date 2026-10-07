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
    var CSS = 'img[src*="/movix"], img[alt*="movix" i], .bb-logo { display: none !important; }';
    var BRAND_RE = /^(\\s*)movix(\\s*)$/i;
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
        var match = BRAND_RE.exec(node.nodeValue || '');
        if (!match) continue;
        var original = node.nodeValue.trim();
        var replacement = original === original.toUpperCase() ? APP_NAME.toUpperCase() : APP_NAME;
        node.nodeValue = match[1] + replacement + match[2];
        var el = node.parentElement;
        if (el && /text-red/.test(el.className || '')) el.style.color = ACCENT;
      }
    }

    function scrub() {
      addStyle();
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

/**
 * @param {object} options
 * @param {string} options.appName
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
  // Toujours inclus quand une expression est fournie, y compris 'false' : le
  // bloc restaure alors le réglage précédent s'il avait été forcé.
  if (adPopupAutoExpr != null) parts.push(buildAdPopupAuto(adPopupAutoExpr, storagePrefix));
  if (swiftfluxSource === 'last' || swiftfluxSource === 'off') parts.push(buildSwiftfluxDemotion(swiftfluxSource));
  parts.push(`
})();
`);
  return parts.join('');
}

module.exports = { buildSiteTweaks, DEFAULT_TOP_LEVEL_ORDER };
