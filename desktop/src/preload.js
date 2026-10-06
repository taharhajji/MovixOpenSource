'use strict';

/**
 * Preload de la fenêtre Movix (contextIsolation activé, pas de Node côté page).
 *
 * 1. Expose `window.__movixDesktop` au monde principal : exécution native des
 *    GM_xmlhttpRequest, ouverture externe, politique de navigation, infos.
 * 2. Sur les pages du site (domaines Movix, hôte local, hôte personnalisé),
 *    injecte le pont GM + le userscript avant tout script de la page.
 */

const { contextBridge, ipcRenderer } = require('electron');
const { classifyExternalUrl, isAllowedInApp, isSiteHost } = require('./lib/navigationPolicy');

function argValue(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : '';
}

const version = argValue('movix-version') || '0.0.0';
const siteHost = argValue('movix-site-host');
const extraHosts = siteHost ? [siteHost] : [];

const hostname = window.location.hostname;
const protocol = window.location.protocol;
const onSite = (protocol === 'http:' || protocol === 'https:') && isSiteHost(hostname, extraHosts);
const onLocalPage = protocol === 'file:';

// État du blocage des pubs : lu une fois, puis tenu à jour par le principal
// (bascule depuis le menu) sans IPC synchrone à chaque window.open.
let adBlockEnabled = ipcRenderer.sendSync('movix:adblock-state') === true;
ipcRenderer.on('movix:adblock-state', (_event, enabled) => {
  adBlockEnabled = enabled === true;
});

const api = {
  version,
  platform: process.platform,
  isAllowedInApp: (url) => isAllowedInApp(String(url), extraHosts),
  isAdBlockEnabled: () => adBlockEnabled,
  classifyUrl: (url) => classifyExternalUrl(String(url), { extraHosts, adBlockEnabled }),
};

if (onSite || onLocalPage) {
  api.openExternal = (url) => ipcRenderer.invoke('movix:open-external', String(url));
  api.reportBlockedPopup = (url) => ipcRenderer.send('movix:popup-blocked', String(url));
}

if (onSite) {
  api.gmFetch = (message) => ipcRenderer.invoke('gm:fetch', message);
  api.gmAbort = (id) => ipcRenderer.invoke('gm:abort', String(id));
}

if (onLocalPage) {
  api.retry = () => ipcRenderer.invoke('movix:retry');
  api.getStatus = () => ipcRenderer.invoke('movix:status');
}

contextBridge.exposeInMainWorld('__movixDesktop', api);

if (onSite) {
  const code = ipcRenderer.sendSync('movix:injection-code');
  if (typeof code === 'string' && code.length > 0) {
    const inject = () => {
      const parent = document.head || document.documentElement;
      if (!parent) return false;
      const script = document.createElement('script');
      script.textContent = code;
      parent.appendChild(script);
      script.remove();
      return true;
    };
    if (!inject()) {
      // Le document n'a pas encore son élément racine : on injecte dès qu'il
      // apparaît, donc avant que le moindre script du site ne soit analysé.
      const observer = new MutationObserver(() => {
        if (inject()) observer.disconnect();
      });
      observer.observe(document, { childList: true });
    }
  }
}
