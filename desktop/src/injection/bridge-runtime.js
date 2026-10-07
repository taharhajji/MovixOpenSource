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

const { buildSiteTweaks } = require('./site-tweaks');

function buildBridgeRuntime({ version, appName = 'MEWFLIX', accent = '#dbe6f6', hideSiteBranding = false, localVip = false, swiftfluxSource = 'keep' }) {
  // Retouches de site partagées avec l'app mobile. Le popup pub suit l'état du
  // blocage des pubs, lu sur le pont natif au chargement de la page.
  const siteTweaks = buildSiteTweaks({
    appName,
    accent,
    hideSiteBranding,
    localVip,
    adPopupAutoExpr: "typeof native.isAdBlockEnabled === 'function' && native.isAdBlockEnabled()",
    swiftfluxSource,
    storagePrefix: 'orbit_desktop',
  });
  return `
(function() {
  'use strict';
  if (window.__MOVIX_DESKTOP_BRIDGE_READY) return;
  var native = window.__movixDesktop;
  if (!native || typeof native.gmFetch !== 'function') return;
  window.__MOVIX_DESKTOP_BRIDGE_READY = true;
  var APP_NAME = ${JSON.stringify(appName)};
  var ACCENT = ${JSON.stringify(accent)};

${siteTweaks}

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
function buildInjectedJavaScript({ version, userscriptSource, appName, accent, hideSiteBranding, localVip, swiftfluxSource }) {
  return `${buildBridgeRuntime({ version, appName, accent, hideSiteBranding, localVip, swiftfluxSource })}

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
