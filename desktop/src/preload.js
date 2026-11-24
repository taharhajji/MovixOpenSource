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
  // Photo de profil MEWFLIX : drapeaux du monde fournis par l'app (lib/flags.js).
  api.profileFlags = () => ipcRenderer.invoke('profile:flags');
  api.profileFlag = (code) => ipcRenderer.invoke('profile:flag', String(code));
  // Mode TV : l'interface injectée (src/injection/tv-app.js) lit l'adresse de
  // la télécommande et pilote la sortie du mode. Exposé seulement s'il est actif.
  if (ipcRenderer.sendSync('tv:enabled') === true) {
    api.tv = {
      info: () => ipcRenderer.invoke('tv:info'),
      setAutoStart: (enabled) => ipcRenderer.invoke('tv:set-autostart', enabled === true),
      exit: () => ipcRenderer.invoke('tv:exit'),
      quit: () => ipcRenderer.invoke('tv:quit'),
    };
  }
}

if (onLocalPage) {
  api.retry = () => ipcRenderer.invoke('movix:retry');
  api.getStatus = () => ipcRenderer.invoke('movix:status');
}

contextBridge.exposeInMainWorld('__movixDesktop', api);

// Bouton « Mode TV » dans la barre du haut du site (fenêtre principale, hors
// mode TV). Il est posé ici, dans le monde isolé du preload : la page ne peut
// pas appeler l'IPC elle-même, et seul un vrai clic de l'utilisateur
// (isTrusted) active le mode — un clic simulé par un script est ignoré.
const TV_BUTTON_MARK = 'data-mewflix-tv-toggle';
const TV_BUTTON_LABEL = 'Mode TV';
const TV_BUTTON_ICON_PATHS = ['M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M8 21h8M12 17v4', 'M10 8.2v4.6l4-2.3z'];
const TV_BUTTON_PLACE_DELAY_MS = 120;

function buildTvButton(model) {
  const button = document.createElement('a');
  button.href = '#';
  button.setAttribute('role', 'button');
  button.setAttribute(TV_BUTTON_MARK, '');
  button.setAttribute('title', 'Plein écran pour la télé, téléphone en télécommande (F9)');
  button.className = model.className;
  button.style.whiteSpace = 'nowrap';
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  const sized = model.querySelector('svg');
  svg.setAttribute('width', (sized && sized.getAttribute('width')) || '16');
  svg.setAttribute('height', (sized && sized.getAttribute('height')) || '16');
  if (sized && sized.getAttribute('class')) svg.setAttribute('class', sized.getAttribute('class'));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of TV_BUTTON_ICON_PATHS) {
    const path = document.createElementNS(svgNs, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  const label = document.createElement('span');
  const modelLabel = model.querySelector('span');
  if (modelLabel && modelLabel.className) label.className = modelLabel.className;
  label.textContent = TV_BUTTON_LABEL;
  button.append(svg, label);
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!event.isTrusted) return;
    ipcRenderer.invoke('tv:enter').catch(() => {});
  });
  return button;
}

function installTvButton() {
  const place = () => {
    // Même repère que le raccourci « TV » des retouches : le lien « Anime »,
    // dans la barre du haut et dans le menu replié.
    for (const anime of document.querySelectorAll('a[href="/anime"]')) {
      const parent = anime.parentNode;
      if (!parent || parent.querySelector(`[${TV_BUTTON_MARK}]`)) continue;
      const after = parent.querySelector('a[data-orbit-nav]') || anime;
      parent.insertBefore(buildTvButton(anime), after.nextSibling);
    }
  };
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      place();
    }, TV_BUTTON_PLACE_DELAY_MS);
  };
  const start = () => {
    place();
    // Le site redessine sa barre en naviguant : le bouton est reposé.
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
}

if (onSite && window.top === window && ipcRenderer.sendSync('tv:can-enter') === true) installTvButton();

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
