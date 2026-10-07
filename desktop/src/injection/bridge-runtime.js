'use strict';

/**
 * Code injecté dans le monde principal de la page Movix, avant tout script du
 * site (équivalent `document-start`). Fournit l'API Tampermonkey attendue par
 * le userscript (GM_xmlhttpRequest, GM_getValue, GM_setValue, GM_deleteValue,
 * GM.*, GM_info, unsafeWindow) sur le pont `window.__movixDesktop` exposé par
 * le preload, puis exécute le userscript lui-même.
 *
 * Pendant de app/src/injection/bridge-runtime.ts (mobile), sans le proxy média
 * local : sur le bureau le moteur web joue les flux directement, et les
 * en-têtes des hébergeurs sont posés par session.webRequest côté principal.
 */

function buildBridgeRuntime({ version, appName = 'Orbit', accent = '#6366f1', hideSiteBranding = false, localVip = false }) {
  return `
(function() {
  'use strict';
  if (window.__MOVIX_DESKTOP_BRIDGE_READY) return;
  var native = window.__movixDesktop;
  if (!native || typeof native.gmFetch !== 'function') return;
  window.__MOVIX_DESKTOP_BRIDGE_READY = true;
  var APP_NAME = ${JSON.stringify(appName)};
  var ACCENT = ${JSON.stringify(accent)};

  // --- Statut VIP local (phase de test) ------------------------------------------
  // Le site lit son statut VIP dans localStorage ('is_vip' === 'true') et le
  // révoque dès que la vérification serveur échoue ou qu'aucun code n'est
  // enregistré (vipUtils.revokeVipStatus → removeItem('is_vip')). On épingle
  // donc la clé au niveau du prototype Storage : toute lecture rend 'true',
  // toute écriture ou suppression est ignorée. Ce que l'API sert uniquement
  // aux vrais codes (en-tête x-access-key) n'est pas concerné.
  if (${localVip ? 'true' : 'false'}) (function pinLocalVip() {
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

  // --- Marque du site masquée dans la page ---------------------------------------
  // Le site n'a pas d'option pour ça : on cache ses images de logo et son intro
  // animée par CSS, et on remplace le texte « MOVIX » du header/footer par le
  // nom de l'app. Un observateur rejoue le remplacement après chaque re-rendu
  // React, en ne parcourant que header/footer (coût négligeable).
  if (${hideSiteBranding ? 'true' : 'false'}) (function hideSiteBranding() {
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

    // Le callback d'un MutationObserver s'exécute en microtâche, donc avant le
    // rendu : remplacer ici évite tout flash de la marque d'origine. Nos
    // propres remplacements déclenchent un nouveau callback, qui ne trouve
    // plus rien à faire ; le garde évite une réentrance pendant le parcours.
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

  // --- Popup « voir une pub avant de regarder » ---------------------------------
  // Le site propose un mode « auto » pour ce popup (réglage Intermission) : rien
  // n'est affiché, le lien pub est ouvert en arrière-plan puis la lecture
  // démarre. Blocage des pubs actif, on force ce mode avant que le site ne lise
  // le réglage : le lien pub tombe dans la fenêtre factice ci-dessous, donc
  // aucune pub ne part, et le popup n'apparaît jamais. Le réglage précédent est
  // mémorisé et restauré si le blocage est désactivé.
  (function syncAdPopupMode() {
    var KEY = 'settings_ad_popup_mode';
    var MARK = 'orbit_desktop:ad_popup_forced';
    try {
      var blocking = typeof native.isAdBlockEnabled === 'function' && native.isAdBlockEnabled();
      var current = localStorage.getItem(KEY);
      if (blocking) {
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

  var _counter = 0;
  function nextId() { return 'gm_' + (++_counter) + '_' + Date.now(); }

  function base64ToArrayBuffer(base64) {
    var binary = atob(base64 || '');
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function bytesToBase64(bytes) {
    var binary = '';
    for (var offset = 0; offset < bytes.length; offset += 32768) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 32768));
    }
    return btoa(binary);
  }

  function encodeBody(data) {
    if (data == null) return { body: null };
    if (typeof data === 'string') return { body: data };
    if (data instanceof ArrayBuffer) return { body: bytesToBase64(new Uint8Array(data)), bodyEncoding: 'base64' };
    if (ArrayBuffer.isView(data)) {
      return { body: bytesToBase64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)), bodyEncoding: 'base64' };
    }
    if (typeof URLSearchParams !== 'undefined' && data instanceof URLSearchParams) return { body: data.toString() };
    if (typeof FormData !== 'undefined' && data instanceof FormData) {
      var params = new URLSearchParams();
      data.forEach(function(value, key) { params.append(key, typeof value === 'string' ? value : ''); });
      return { body: params.toString() };
    }
    try { return { body: JSON.stringify(data) }; } catch (e) { return { body: String(data) }; }
  }

  function headersToString(headers) {
    var out = '';
    for (var key in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, key)) out += key + ': ' + headers[key] + '\\r\\n';
    }
    return out;
  }

  function contentTypeOf(headers) {
    for (var key in headers) {
      if (key.toLowerCase() === 'content-type') return headers[key];
    }
    return '';
  }

  function GM_xmlhttpRequest(details) {
    details = details || {};
    var id = nextId();
    var cancelled = false;
    var encoded = encodeBody(details.data);
    var message = {
      id: id,
      url: String(details.url || ''),
      method: String(details.method || 'GET').toUpperCase(),
      headers: details.headers || {},
      body: encoded.body,
      bodyEncoding: encoded.bodyEncoding,
      responseType: details.responseType || '',
      timeout: details.timeout || 30000,
      anonymous: details.anonymous === true
    };

    var callbacks = details;
    Promise.resolve()
      .then(function() { return native.gmFetch(message); })
      .then(function(response) {
        if (cancelled) return;
        if (!response || !response.success) {
          var error = {
            error: (response && response.error) || 'Requête échouée',
            status: 0,
            statusText: (response && response.error) || 'Erreur',
            readyState: 4,
            responseHeaders: '',
            response: null,
            responseText: '',
            finalUrl: message.url
          };
          if (response && response.timedOut && typeof callbacks.ontimeout === 'function') callbacks.ontimeout(error);
          else if (typeof callbacks.onerror === 'function') callbacks.onerror(error);
          if (typeof callbacks.onloadend === 'function') callbacks.onloadend(error);
          return;
        }

        var headers = response.headers || {};
        var body;
        var text = '';
        if (response.bodyEncoding === 'base64') {
          var buffer = base64ToArrayBuffer(response.body);
          if (message.responseType === 'blob') body = new Blob([buffer], { type: contentTypeOf(headers) });
          else body = buffer;
        } else {
          text = response.body || '';
          if (message.responseType === 'json') {
            try { body = JSON.parse(text); } catch (e) { body = null; }
          } else {
            body = text;
          }
        }

        var gmResponse = {
          status: response.status || 0,
          statusText: response.statusText || '',
          readyState: 4,
          responseHeaders: headersToString(headers),
          response: body,
          responseText: text,
          responseXML: null,
          finalUrl: response.finalUrl || message.url,
          context: details.context
        };
        if (typeof callbacks.onreadystatechange === 'function') callbacks.onreadystatechange(gmResponse);
        if (typeof callbacks.onload === 'function') callbacks.onload(gmResponse);
        if (typeof callbacks.onloadend === 'function') callbacks.onloadend(gmResponse);
      })
      .catch(function(err) {
        if (cancelled) return;
        if (typeof callbacks.onerror === 'function') {
          callbacks.onerror({ error: String(err && err.message || err), status: 0, statusText: 'Erreur', readyState: 4 });
        }
      });

    return {
      abort: function() {
        if (cancelled) return;
        cancelled = true;
        try { native.gmAbort(id); } catch (e) {}
        if (typeof callbacks.onabort === 'function') callbacks.onabort({ status: 0, readyState: 4 });
      }
    };
  }

  // --- Stockage : synchrone, persistant dans localStorage (même clé que l'app mobile) ---
  var STORAGE_PREFIX = 'movix_userscript:';
  var _storageCache = {};

  function GM_getValue(key, defaultValue) {
    if (key in _storageCache) return _storageCache[key];
    try {
      var stored = localStorage.getItem(STORAGE_PREFIX + key);
      if (stored !== null) {
        var parsed = JSON.parse(stored);
        _storageCache[key] = parsed;
        return parsed;
      }
    } catch (e) {}
    return defaultValue;
  }

  function GM_setValue(key, value) {
    _storageCache[key] = value;
    try { localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value)); } catch (e) {}
  }

  function GM_deleteValue(key) {
    delete _storageCache[key];
    try { localStorage.removeItem(STORAGE_PREFIX + key); } catch (e) {}
  }

  function GM_listValues() {
    var keys = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(STORAGE_PREFIX) === 0) keys.push(k.slice(STORAGE_PREFIX.length));
      }
    } catch (e) {}
    return keys;
  }

  // --- Fenêtres : les liens externes partent dans le navigateur ; blocage des
  // pubs actif, les popups vers des hôtes non sûrs (régies, smartlinks) sont
  // neutralisés : la page reçoit un objet fenêtre factice, donc ses flux
  // « voir une pub » se valident sans qu'aucune pub ne parte.
  var nativeOpen = typeof window.open === 'function' ? window.open.bind(window) : null;
  function fakeWindow(href) {
    var fake = {
      closed: false,
      close: function() { fake.closed = true; },
      focus: function() {},
      blur: function() {},
      postMessage: function() {},
      location: { href: href },
      opener: null
    };
    return fake;
  }
  window.open = function(url, target, features) {
    try {
      var absolute = new URL(String(url == null ? '' : url), location.href);
      if (absolute.protocol === 'http:' || absolute.protocol === 'https:') {
        var kind = typeof native.classifyUrl === 'function'
          ? native.classifyUrl(absolute.href)
          : (native.isAllowedInApp(absolute.href) ? 'app' : 'external');
        if (kind === 'blocked') {
          try { if (native.reportBlockedPopup) native.reportBlockedPopup(absolute.href); } catch (e) {}
          return fakeWindow(absolute.href);
        }
        if (kind === 'external') {
          native.openExternal(absolute.href);
          return fakeWindow(absolute.href);
        }
      }
    } catch (e) {}
    return nativeOpen ? nativeOpen(url, target, features) : null;
  };

  // --- Exposition globale (API Tampermonkey) ---
  window.GM_xmlhttpRequest = GM_xmlhttpRequest;
  window.GM_getValue = GM_getValue;
  window.GM_setValue = GM_setValue;
  window.GM_deleteValue = GM_deleteValue;
  window.GM_listValues = GM_listValues;
  window.GM_info = {
    scriptHandler: APP_NAME + ' Desktop',
    version: ${JSON.stringify(version)},
    script: { name: 'Movix Proxy Extension', namespace: 'https://movix.cash', version: ${JSON.stringify(version)} }
  };
  window.GM = {
    info: window.GM_info,
    xmlHttpRequest: GM_xmlhttpRequest,
    getValue: function(key, defaultValue) { return Promise.resolve(GM_getValue(key, defaultValue)); },
    setValue: function(key, value) { GM_setValue(key, value); return Promise.resolve(); },
    deleteValue: function(key) { GM_deleteValue(key); return Promise.resolve(); },
    listValues: function() { return Promise.resolve(GM_listValues()); }
  };
  window.unsafeWindow = window;
  window.__MOVIX_DESKTOP__ = { version: ${JSON.stringify(version)}, platform: 'windows' };

  console.log('[' + APP_NAME + '] Pont GM initialisé (v' + ${JSON.stringify(version)} + ')');
})();
`;
}

/**
 * Assemble le script complet : pont GM puis userscript.
 */
function buildInjectedJavaScript({ version, userscriptSource, appName, accent, hideSiteBranding, localVip }) {
  return `${buildBridgeRuntime({ version, appName, accent, hideSiteBranding, localVip })}

// --- Userscript Movix ---
(function() {
  if (!window.__MOVIX_DESKTOP_BRIDGE_READY || window.__MOVIX_DESKTOP_USERSCRIPT_DONE) return;
  window.__MOVIX_DESKTOP_USERSCRIPT_DONE = true;
  var GM_xmlhttpRequest = window.GM_xmlhttpRequest;
  var GM_getValue = window.GM_getValue;
  var GM_setValue = window.GM_setValue;
  var GM_deleteValue = window.GM_deleteValue;
  var GM_info = window.GM_info;
  var unsafeWindow = window;
${userscriptSource}
})();
`;
}

module.exports = { buildBridgeRuntime, buildInjectedJavaScript };
