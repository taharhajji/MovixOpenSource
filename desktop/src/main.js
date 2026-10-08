'use strict';

/**
 * Movix Desktop — processus principal.
 *
 * Charge le site Movix en direct (API et serveurs de production, ou un hôte
 * imposé par la team via --site / config.json), avec :
 *  - résolution automatique des miroirs et bascule si l'un tombe ;
 *  - l'extension Movix intégrée (userscript + pont GM natif, sans CORS) ;
 *  - règles d'en-têtes des hébergeurs sur les requêtes média du moteur web ;
 *  - liens externes dans le navigateur, OAuth Discord/Google dans la fenêtre ;
 *  - mises à jour automatiques depuis les releases GitHub (build packagé).
 */

const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  nativeImage,
  net,
  session,
  shell,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const { AppConfig } = require('./lib/config');
const { resolveAddressConfig } = require('./lib/addressResolver');
const { gmFetch, abortGmRequest } = require('./lib/gmFetch');
const { applyMediaProxyHeaderRules, isProviderUrl, hostnameOf, stripSecFetchHeaders } = require('./lib/mediaProxyHeaders');
const { classifyExternalUrl, isAllowedInApp, isHttpUrl, isSiteHost } = require('./lib/navigationPolicy');
const { buildInjectedJavaScript } = require('./injection/bridge-runtime');
const { buildMenu } = require('./lib/menu');
const { AdBlocker } = require('./lib/adBlock');
const BRAND = require('./branding');

const APP_ID = BRAND.APP_ID;
const APP_NAME = BRAND.APP_NAME;
const IS_DEV = !app.isPackaged || process.argv.includes('--dev');
const MIRROR_DOWN_STATUSES = new Set([500, 502, 504, 520, 521, 522, 523, 524, 525, 526, 530]);
const ADDRESS_CACHE_FILE = 'address-cache.json';
const USERSCRIPT_PATH = path.join(__dirname, '..', 'resources', 'movix.user.js');
const ICON_PATH = path.join(__dirname, '..', 'build', 'icon.png');
const PAGES_DIR = path.join(__dirname, 'pages');

// ---------------------------------------------------------------------------
// Démarrage : instance unique, identité Windows, commutateurs Chromium
// ---------------------------------------------------------------------------

// Profil séparé (tests, second compte) : MOVIX_USER_DATA=<dossier>.
if (process.env.MOVIX_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.MOVIX_USER_DATA));
}

if (!app.requestSingleInstanceLock()) {
  console.log(`[movix] ${BRAND.APP_NAME} est déjà ouvert : cette instance se ferme et met l'autre au premier plan.`);
  app.quit();
} else {
  bootstrap();
}

function bootstrap() {
  app.setAppUserModelId(APP_ID);
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');

  const config = new AppConfig(app.getPath('userData'), { argv: process.argv, env: process.env });

  // User-Agent Chrome standard : Google refuse l'OAuth aux navigateurs
  // embarqués qu'il reconnaît (signature « Electron/ »). Le suffixe permet à
  // l'API Movix d'identifier les sessions bureau.
  app.userAgentFallback =
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) `
    + `Chrome/${process.versions.chrome} Safari/537.36 ${BRAND.UA_TOKEN}/${app.getVersion()}`;

  /** @type {BrowserWindow | null} */
  let mainWindow = null;
  /** @type {{ primaryUrl: string, mirrors: string[], githubUrl: string, telegramUrl: string, source: string }} */
  let address = null;
  /** @type {string[]} */
  let chain = [];
  let chainIndex = 0;
  let currentMirrorUrl = '';
  let injectionCode = '';
  let lastFailure = '';

  // Blocage des pubs (phase de test) : liste intégrée active tout de suite,
  // moteur EasyList/EasyPrivacy chargé en arrière-plan après la fenêtre.
  const adBlocker = new AdBlocker({
    cacheDir: app.getPath('userData'),
    isSiteHost: (hostname) => isSiteHost(hostname, siteExtraHosts()),
    log: console,
  });
  adBlocker.enabled = config.adBlockEnabled;

  function setAdBlock(enabled) {
    adBlocker.enabled = Boolean(enabled);
    config.set('adBlock', adBlocker.enabled);
    for (const contents of require('electron').webContents.getAllWebContents()) {
      try {
        contents.send('movix:adblock-state', adBlocker.enabled);
      } catch {
        // fenêtre en cours de fermeture
      }
    }
    console.log(`[adblock] ${adBlocker.enabled ? 'activé' : 'désactivé'}`);
    refreshMenu();
  }

  /**
   * Ouvre une URL externe dans le navigateur, sauf si le blocage des pubs est
   * actif et que l'hôte n'est pas une destination sûre connue (Telegram,
   * GitHub…) : une pub (smartlink, popunder) est alors simplement ignorée.
   */
  function openExternalOrBlock(url) {
    const kind = classifyExternalUrl(url, { extraHosts: siteExtraHosts(), adBlockEnabled: adBlocker.enabled });
    if (kind === 'blocked') {
      adBlocker.recordBlockedPopup(url);
      if (IS_DEV) console.log(`[adblock] popup ignoré : ${String(url).slice(0, 120)}`);
      return false;
    }
    if (!isHttpUrl(url)) return false;
    shell.openExternal(String(url)).catch(() => {});
    return true;
  }

  // --- Userscript + pont GM --------------------------------------------------

  function loadInjectionCode() {
    try {
      const userscriptSource = fs.readFileSync(USERSCRIPT_PATH, 'utf8');
      injectionCode = buildInjectedJavaScript({
        version: app.getVersion(),
        userscriptSource,
        appName: APP_NAME,
        accent: BRAND.ACCENT,
        hideSiteBranding: config.hideSiteBranding,
        localVip: config.localVipEnabled,
        swiftfluxSource: config.swiftfluxSource,
      });
      console.log(`[movix] source SwiftFlux (vérification robot) : ${config.swiftfluxSource}`);
      console.log(`[movix] marque du site ${config.hideSiteBranding ? 'masquée' : 'visible'} dans la page`);
      console.log(`[movix] statut VIP local ${config.localVipEnabled ? 'actif' : 'désactivé'}`);
      console.log(`[movix] userscript chargé (${(userscriptSource.length / 1024).toFixed(0)} Ko)`);
    } catch (err) {
      injectionCode = '';
      console.error('[movix] userscript introuvable : lancez `npm run sync:userscript`', err.message);
    }
  }

  // --- Miroirs ----------------------------------------------------------------

  function addressCachePath() {
    return path.join(app.getPath('userData'), ADDRESS_CACHE_FILE);
  }

  async function resolveAddress() {
    address = await resolveAddressConfig({
      fetchImpl: (url, init) => net.fetch(url, init),
      readCache: () => {
        try {
          return JSON.parse(fs.readFileSync(addressCachePath(), 'utf8'));
        } catch {
          return null;
        }
      },
      writeCache: (value) => fs.writeFileSync(addressCachePath(), JSON.stringify(value), 'utf8'),
      warn: (msg, err) => console.warn(msg, err && err.message ? err.message : ''),
    });
    console.log(`[movix] adresses résolues via ${address.source} : ${address.primaryUrl} (+${address.mirrors.length} miroirs)`);
    rebuildChain();
  }

  function rebuildChain() {
    const forced = config.forcedSiteUrl;
    if (forced) {
      chain = [forced];
    } else {
      const ordered = [address.primaryUrl, ...address.mirrors];
      const last = config.get('lastMirror');
      if (last && ordered.includes(last)) {
        ordered.splice(ordered.indexOf(last), 1);
        ordered.unshift(last);
      }
      chain = [...new Set(ordered)];
    }
    chainIndex = 0;
  }

  function siteExtraHosts() {
    const forced = config.forcedSiteUrl;
    if (!forced) return [];
    try {
      return [new URL(forced).hostname];
    } catch {
      return [];
    }
  }

  function loadMirror(index, pathname = '/') {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    chainIndex = index;
    currentMirrorUrl = chain[index];
    const target = `${currentMirrorUrl}${pathname}`;
    console.log(`[movix] chargement ${target}`);
    refreshMenu();
    mainWindow.loadURL(target).catch((err) => {
      // loadURL rejette aussi sur un did-fail-load, déjà traité par l'écouteur.
      if (IS_DEV) console.warn('[movix] loadURL', err && err.message);
    });
  }

  function advanceMirror(reason) {
    lastFailure = reason;
    console.warn(`[movix] miroir ${chain[chainIndex]} en échec : ${reason}`);
    if (chainIndex + 1 < chain.length) {
      loadMirror(chainIndex + 1);
    } else {
      showErrorPage();
    }
  }

  function loadLocalPage(file) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.loadFile(path.join(PAGES_DIR, file), { query: { name: APP_NAME } }).catch(() => {});
  }

  function showErrorPage() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    currentMirrorUrl = '';
    refreshMenu();
    loadLocalPage('error.html');
  }

  async function restartFromScratch() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    loadLocalPage('loading.html');
    await resolveAddress();
    loadMirror(0);
  }

  function isChainUrl(url) {
    const host = hostnameOf(url);
    if (!host) return false;
    return chain.some((entry) => hostnameOf(entry) === host);
  }

  // --- Fenêtre ----------------------------------------------------------------

  function windowOptions(extra = {}) {
    const icon = fs.existsSync(ICON_PATH) ? nativeImage.createFromPath(ICON_PATH) : undefined;
    return {
      width: 1280,
      height: 800,
      minWidth: 900,
      minHeight: 560,
      backgroundColor: BRAND.BACKGROUND,
      title: APP_NAME,
      icon,
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        backgroundThrottling: false,
        additionalArguments: [
          `--movix-version=${app.getVersion()}`,
          ...siteExtraHosts().map((host) => `--movix-site-host=${host}`),
        ],
      },
      ...extra,
    };
  }

  function createMainWindow() {
    const bounds = config.get('windowBounds');
    const options = windowOptions(bounds && typeof bounds === 'object' ? {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    } : {});
    mainWindow = new BrowserWindow(options);
    if (bounds && bounds.maximized) mainWindow.maximize();

    mainWindow.once('ready-to-show', () => mainWindow.show());
    const zoom = Number(config.get('zoomFactor'));
    if (zoom > 0.3 && zoom < 4) mainWindow.webContents.setZoomFactor(zoom);

    const persistBounds = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const maximized = mainWindow.isMaximized();
      const current = maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
      config.set('windowBounds', { ...current, maximized });
    };
    mainWindow.on('close', persistBounds);
    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    const wc = mainWindow.webContents;
    wc.on('zoom-changed', () => config.set('zoomFactor', wc.getZoomFactor()));

    // La fenêtre garde le nom de l'app : jamais le <title> du site.
    mainWindow.on('page-title-updated', (event) => {
      event.preventDefault();
      if (mainWindow.getTitle() !== APP_NAME) mainWindow.setTitle(APP_NAME);
    });

    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return; // -3 : navigation annulée (normal)
      if (!isChainUrl(validatedURL) || hostnameOf(validatedURL) !== hostnameOf(currentMirrorUrl)) return;
      advanceMirror(`${errorDescription} (${errorCode})`);
    });

    wc.on('did-navigate', (_event, url, httpResponseCode) => {
      if (!isChainUrl(url)) return;
      if (MIRROR_DOWN_STATUSES.has(httpResponseCode)) {
        advanceMirror(`HTTP ${httpResponseCode}`);
        return;
      }
      if (httpResponseCode >= 200 && httpResponseCode < 400 && !config.forcedSiteUrl) {
        const origin = new URL(url).origin;
        if (chain.includes(origin) && config.get('lastMirror') !== origin) {
          config.set('lastMirror', origin);
        }
        if (chain.includes(origin) && currentMirrorUrl !== origin) {
          currentMirrorUrl = origin;
          chainIndex = chain.indexOf(origin);
          refreshMenu();
        }
      }
    });

    if (IS_DEV) {
      wc.on('console-message', (_event, level, message) => {
        const tag = ['verbose', 'info', 'warning', 'error'][level] || 'log';
        console.log(`[page:${tag}] ${String(message).slice(0, 600)}`);
      });
    }

    if (process.env.MOVIX_SMOKE) {
      // Capture de l'écran de chargement (logo, nom) avant la page du site.
      wc.once('did-finish-load', async () => {
        try {
          await new Promise((resolve) => setTimeout(resolve, 400));
          const shot = await wc.capturePage();
          fs.writeFileSync(path.join(__dirname, '..', 'smoke-loading.png'), shot.toPNG());
        } catch {
          // capture facultative
        }
        runSmokeTest(wc);
      });
    }

    wc.on('render-process-gone', (_event, details) => {
      console.error('[movix] renderer terminé :', details.reason);
      if (details.reason !== 'clean-exit' && mainWindow && !mainWindow.isDestroyed()) {
        loadMirror(chainIndex);
      }
    });

    return mainWindow;
  }

  function attachNavigationPolicy(contents) {
    const extra = siteExtraHosts();

    contents.on('will-navigate', (event, url) => {
      if (isAllowedInApp(url, extra)) return;
      event.preventDefault();
      openExternalOrBlock(url);
    });

    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedInApp(url, extra) && isHttpUrl(url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: windowOptions({ width: 1100, height: 760, show: true }),
        };
      }
      openExternalOrBlock(url);
      return { action: 'deny' };
    });

    contents.on('context-menu', (_event, params) => {
      const template = [];
      if (params.linkURL) {
        template.push({
          label: 'Ouvrir le lien dans le navigateur',
          click: () => shell.openExternal(params.linkURL).catch(() => {}),
        });
        template.push({ label: 'Copier l’adresse du lien', click: () => require('electron').clipboard.writeText(params.linkURL) });
        template.push({ type: 'separator' });
      }
      if (params.isEditable) {
        template.push({ label: 'Couper', role: 'cut' }, { label: 'Copier', role: 'copy' }, { label: 'Coller', role: 'paste' });
      } else if (params.selectionText) {
        template.push({ label: 'Copier', role: 'copy' });
      }
      if (template.length) template.push({ type: 'separator' });
      template.push({ label: 'Page précédente', enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() });
      template.push({ label: 'Recharger', click: () => contents.reload() });
      if (IS_DEV) template.push({ label: 'Inspecter', click: () => contents.inspectElement(params.x, params.y) });
      Menu.buildFromTemplate(template).popup();
    });
  }

  // --- Réseau : en-têtes des hébergeurs, CORS, CSP --------------------------

  function installWebRequestHooks(ses) {
    const filter = { urls: ['http://*/*', 'https://*/*'] };
    const mediaTypes = new Set(['media', 'xhr', 'xmlhttprequest', 'other', 'subFrame', 'image', 'script', 'stylesheet', 'font']);

    // Unique hook onBeforeRequest de l'app (Electron n'en accepte qu'un par
    // session) : blocage des pubs, toutes couches confondues.
    ses.webRequest.onBeforeRequest(filter, (details, callback) => {
      const fromMainProcess = details.webContentsId == null;
      if (adBlocker.shouldBlock({ url: details.url, resourceType: details.resourceType, referrer: details.referrer, fromMainProcess })) {
        if (IS_DEV) console.log(`[adblock] bloqué ${details.resourceType} ${details.url.slice(0, 120)}`);
        callback({ cancel: true });
        return;
      }
      callback({});
    });

    ses.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      if (!isProviderUrl(details.url) || !mediaTypes.has(details.resourceType)) {
        callback({ requestHeaders: details.requestHeaders });
        return;
      }
      // Les Sec-Fetch-* d'origine (calculés par Chromium) sont conservés tels quels.
      const ruled = stripSecFetchHeaders(applyMediaProxyHeaderRules(details.url, details.requestHeaders));
      for (const [name, value] of Object.entries(details.requestHeaders)) {
        if (/^sec-fetch-/i.test(name)) ruled[name] = value;
      }
      callback({ requestHeaders: ruled });
    });

    ses.webRequest.onHeadersReceived(filter, (details, callback) => {
      const headers = { ...(details.responseHeaders || {}) };
      const targetHost = hostnameOf(details.url);
      const extra = siteExtraHosts();
      const fromSite = (() => {
        const ref = details.referrer ? hostnameOf(details.referrer) : null;
        return ref ? isSiteHost(ref, extra) : false;
      })();

      const lower = Object.fromEntries(Object.keys(headers).map((key) => [key.toLowerCase(), key]));

      // Un Movix servi avec une CSP stricte bloquerait le script injecté :
      // comme un gestionnaire de userscripts, on la retire sur le site lui-même.
      if (details.resourceType === 'mainFrame' && isSiteHost(targetHost, extra)) {
        for (const name of ['content-security-policy', 'content-security-policy-report-only', 'x-frame-options']) {
          if (lower[name]) delete headers[lower[name]];
        }
      }

      // Parité avec la règle n°1 de l'extension Chrome : CORS ouvert pour les
      // ressources tierces demandées par le site (sources, sous-titres, images…).
      // L'API Movix pose déjà ses propres en-têtes CORS : on ne les touche pas.
      if (fromSite && targetHost && !isSiteHost(targetHost, extra) && !lower['access-control-allow-origin']) {
        headers['Access-Control-Allow-Origin'] = ['*'];
        headers['Access-Control-Allow-Methods'] = ['GET, POST, OPTIONS, HEAD, PUT, DELETE, PATCH'];
        headers['Access-Control-Allow-Headers'] = ['*'];
        headers['Access-Control-Expose-Headers'] = ['*'];
      }
      callback({ responseHeaders: headers });
    });
  }

  // --- IPC ------------------------------------------------------------------

  function registerIpc() {
    ipcMain.on('movix:injection-code', (event) => {
      event.returnValue = injectionCode;
    });
    ipcMain.handle('gm:fetch', (event, message) => gmFetch(message || {}, event.sender.session));
    ipcMain.handle('gm:abort', (_event, id) => abortGmRequest(id));
    ipcMain.handle('movix:open-external', (_event, url) => openExternalOrBlock(String(url)));
    ipcMain.on('movix:adblock-state', (event) => {
      event.returnValue = adBlocker.enabled;
    });
    ipcMain.on('movix:popup-blocked', (_event, url) => {
      adBlocker.recordBlockedPopup(String(url));
      if (IS_DEV) console.log(`[adblock] popup neutralisé : ${String(url).slice(0, 120)}`);
    });
    ipcMain.handle('movix:retry', () => restartFromScratch());
    ipcMain.handle('movix:status', () => ({
      version: app.getVersion(),
      tried: chain,
      lastFailure,
      forcedSiteUrl: config.forcedSiteUrl,
      githubUrl: address ? address.githubUrl : 'https://github.com/movixstream/MovixOpenSource',
      telegramUrl: address ? address.telegramUrl : 'https://t.me/movix_site',
      source: address ? address.source : '',
    }));
  }

  // --- Menu -----------------------------------------------------------------

  function refreshMenu() {
    if (!address) return;
    // Les serveurs sont numérotés, jamais nommés par leur domaine.
    const mirrors = chain.map((url, index) => ({ url, label: `Serveur ${index + 1}` }));
    const menu = buildMenu({
      appName: APP_NAME,
      reload: () => mainWindow && mainWindow.webContents.reload(),
      home: () => loadMirror(chainIndex >= 0 && chainIndex < chain.length ? chainIndex : 0),
      back: () => mainWindow && mainWindow.webContents.navigationHistory.goBack(),
      forward: () => mainWindow && mainWindow.webContents.navigationHistory.goForward(),
      mirrors,
      currentMirrorUrl,
      siteForced: Boolean(config.forcedSiteUrl),
      adBlockEnabled: adBlocker.enabled,
      toggleAdBlock: setAdBlock,
      secureDnsEnabled: config.secureDnsEnabled,
      toggleSecureDns: setSecureDns,
      localVipEnabled: config.localVipEnabled,
      toggleLocalVip: (enabled) => {
        config.set('localVip', Boolean(enabled));
        loadInjectionCode();
        refreshMenu();
        if (mainWindow) mainWindow.webContents.reload();
      },
      selectMirror: (url) => {
        const index = chain.indexOf(url);
        if (index >= 0) {
          config.set('lastMirror', url);
          loadMirror(index);
        }
      },
      refreshMirrors: () => restartFromScratch(),
      checkUpdates: () => checkForUpdates(true),
      openExternal: (url) => shell.openExternal(url).catch(() => {}),
      openConfigFolder: () => shell.openPath(app.getPath('userData')),
      about: showAbout,
      githubUrl: address.githubUrl,
      telegramUrl: address.telegramUrl,
    });
    Menu.setApplicationMenu(menu);
  }

  function showAbout() {
    const serverIndex = chain.indexOf(currentMirrorUrl);
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: `À propos de ${APP_NAME}`,
      message: `${APP_NAME} ${app.getVersion()} — ${BRAND.TAGLINE}`,
      detail: [
        `Serveur : ${serverIndex >= 0 ? `n°${serverIndex + 1}` : '(aucun)'}${config.forcedSiteUrl ? ' (imposé par la configuration)' : ''} · ${chain.length} connus`,
        (() => {
          const s = adBlocker.summary();
          return s.enabled
            ? `Blocage des pubs : actif (moteur ${s.engine}) — ${s.requests} requêtes et ${s.popups} popups bloqués${s.top.length ? ` · ${s.top.join(', ')}` : ''}`
            : 'Blocage des pubs : désactivé';
        })(),
        `DNS sécurisé (DoH) : ${config.secureDnsEnabled ? 'actif' : 'désactivé'}`,
        `Statut VIP local : ${config.localVipEnabled ? 'actif' : 'désactivé'}`,
        `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
      ].join('\n'),
      buttons: ['Fermer'],
    }).catch(() => {});
  }

  // --- Mises à jour (releases GitHub, build packagé uniquement) ---------------

  let autoUpdater = null;

  function initAutoUpdate() {
    if (!app.isPackaged) return;
    try {
      ({ autoUpdater } = require('electron-updater'));
    } catch (err) {
      console.warn('[movix] electron-updater indisponible :', err.message);
      return;
    }
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('error', (err) => console.warn('[movix] mise à jour :', err && err.message));
    autoUpdater.on('update-downloaded', (info) => {
      dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: 'Mise à jour prête',
        message: `${APP_NAME} ${info.version} est téléchargé.`,
        detail: 'Redémarrer maintenant pour l’installer ? Sinon elle s’installera à la fermeture.',
        buttons: ['Redémarrer', 'Plus tard'],
        defaultId: 0,
        cancelId: 1,
      }).then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      }).catch(() => {});
    });
    checkForUpdates(false);
  }

  function checkForUpdates(interactive) {
    if (!autoUpdater) {
      if (interactive) {
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'Mises à jour',
          message: app.isPackaged
            ? 'Le module de mise à jour n’est pas disponible.'
            : 'Les mises à jour automatiques ne s’appliquent qu’au build packagé.',
          buttons: ['OK'],
        }).catch(() => {});
      }
      return;
    }
    autoUpdater.checkForUpdates().then((result) => {
      if (!interactive) return;
      const available = result && result.updateInfo && result.updateInfo.version !== app.getVersion();
      if (!available) {
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'Mises à jour',
          message: `${APP_NAME} ${app.getVersion()} est à jour.`,
          buttons: ['OK'],
        }).catch(() => {});
      }
    }).catch((err) => {
      if (interactive) {
        dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: 'Mises à jour',
          message: 'Impossible de vérifier les mises à jour.',
          detail: err && err.message ? err.message : String(err),
          buttons: ['OK'],
        }).catch(() => {});
      }
    });
  }

  // --- Test de fumée (MOVIX_SMOKE=1) : vérifie l'injection et le pont GM ------

  async function runSmokeTest(wc) {
    const pageUrl = wc.getURL();
    if (!isChainUrl(pageUrl)) {
      wc.once('did-finish-load', () => runSmokeTest(wc));
      return;
    }
    const probeUrl = `${new URL(pageUrl).origin}/`;
    const snippet = `
      new Promise((resolve) => {
        const out = {
          url: location.href,
          bridge: window.__MOVIX_DESKTOP_BRIDGE_READY === true,
          gm: typeof GM_xmlhttpRequest,
          userscript: window.hasMovixUserscript === true || window.__MOVIX_EXTENSION_INSTALLED === true,
          dataset: document.documentElement.dataset.movixExtension,
          chromeShim: typeof chrome === 'object' && !!chrome.declarativeNetRequest,
          adPopupMode: (function() { try { return localStorage.getItem('settings_ad_popup_mode'); } catch (e) { return null; } })(),
          swiftflux: (function() {
            try {
              var prefs = JSON.parse(localStorage.getItem('settings_source_priority_prefs') || 'null');
              var order = prefs && prefs.categories && prefs.categories.moviesTv && prefs.categories.moviesTv.sourceOrder;
              if (!order) return null;
              var idx = order.findIndex(function(e) { return e && e.id === 'swiftflux'; });
              return { position: idx + 1, of: order.length, enabled: idx >= 0 ? order[idx].enabled : null };
            } catch (e) { return null; }
          })(),
          vip: (function() {
            try {
              localStorage.removeItem('is_vip');
              return localStorage.getItem('is_vip') === 'true' && window.__ORBIT_LOCAL_VIP__ === true;
            } catch (e) { return false; }
          })(),
        };
        if (typeof GM_xmlhttpRequest !== 'function') return resolve(out);
        // Pub : une requête vers une régie connue doit échouer (ERR_BLOCKED_BY_CLIENT)
        // et un popup vers un smartlink doit être neutralisé (objet factice, pas d'ouverture).
        const adProbe = fetch('https://www.google-analytics.com/analytics.js', { mode: 'no-cors', cache: 'no-store' })
          .then(() => 'chargé', () => 'bloqué');
        try {
          const popup = window.open('https://smartlink.example-ads.test/go?x=1', '_blank');
          out.adPopup = popup && typeof popup.close === 'function' ? 'neutralisé' : 'ouvert';
        } catch (e) { out.adPopup = 'erreur'; }
        // Marque du site : attend le header React, puis lit le texte du lien logo.
        const brandProbe = new Promise((done) => {
          const started = Date.now();
          let firstSeenAt = 0;
          (function poll() {
            const link = document.querySelector('header a[href="/"]');
            const text = link ? link.textContent.trim() : '';
            if (text) {
              if (!firstSeenAt) firstSeenAt = Date.now();
              // Laisse 1,5 s au remplacement après l'apparition du header.
              if (!/movix/i.test(text) || Date.now() - firstSeenAt > 1500) return done(text);
            }
            if (Date.now() - started > 20000) return done(text || null);
            setTimeout(poll, 100);
          })();
        });
        const finish = (extra) => Promise.all([adProbe, brandProbe])
          .then(([adResult, brandResult]) => resolve({ ...out, adProbe: adResult, headerBrand: brandResult, ...extra }));
        const timer = setTimeout(() => finish({ probe: 'timeout' }), 15000);
        GM_xmlhttpRequest({
          method: 'GET',
          url: ${JSON.stringify(probeUrl)},
          headers: { 'X-Movix-Smoke': '1' },
          onload: (r) => { clearTimeout(timer); finish({ probe: { status: r.status, finalUrl: r.finalUrl, bytes: (r.responseText || '').length, headers: r.responseHeaders.split('\\r\\n').length } }); },
          onerror: (e) => { clearTimeout(timer); finish({ probe: { error: e.error } }); },
        });
      })`;
    let result;
    try {
      result = await wc.executeJavaScript(snippet, true);
    } catch (err) {
      result = { error: err && err.message };
    }
    if (result) {
      result.adBlock = adBlocker.summary();
      result.windowTitle = mainWindow ? mainWindow.getTitle() : null;
    }
    const adOk = !adBlocker.enabled
      || (result && result.adProbe === 'bloqué' && result.adPopup === 'neutralisé' && result.adPopupMode === 'auto');
    const titleOk = result && result.windowTitle === APP_NAME;
    const brandOk = !config.hideSiteBranding
      || (result && typeof result.headerBrand === 'string' && !/movix/i.test(result.headerBrand));
    const vipOk = !config.localVipEnabled || (result && result.vip === true);
    const swiftfluxOk = config.swiftfluxSource === 'keep'
      || (result && result.swiftflux && result.swiftflux.position === result.swiftflux.of
        && result.swiftflux.enabled === (config.swiftfluxSource !== 'off'));
    const ok = result && result.bridge && result.gm === 'function' && result.userscript
      && result.probe && result.probe.status === 200 && adOk && titleOk && brandOk && vipOk && swiftfluxOk;
    // Capture de la fenêtre pour vérification visuelle (desktop/smoke.png).
    try {
      const shot = await wc.capturePage();
      fs.writeFileSync(path.join(__dirname, '..', 'smoke.png'), shot.toPNG());
    } catch (err) {
      console.warn('[movix:smoke] capture impossible :', err && err.message);
    }
    console.log(`[movix:smoke] ${JSON.stringify(result)}`);
    console.log(`[movix:smoke] ${ok ? 'OK' : 'ÉCHEC'}`);
    if (ok && process.env.MOVIX_SMOKE_PLAY) {
      const playOk = await runPlaybackTest(wc, process.env.MOVIX_SMOKE_PLAY);
      setTimeout(() => app.exit(playOk ? 0 : 2), 200);
      return;
    }
    setTimeout(() => app.exit(ok ? 0 : 1), 200);
  }

  // Lecture vidéo réelle : MOVIX_SMOKE_PLAY=/watch/movie/<id>. Attend qu'un
  // <video> de la page avance (lecture effective), capture desktop/smoke-play.png.
  async function runPlaybackTest(wc, pathname) {
    const origin = new URL(wc.getURL()).origin;
    console.log(`[movix:play] navigation vers ${origin}${pathname}`);
    await wc.loadURL(`${origin}${pathname}`).catch(() => {});
    const snippet = `
      new Promise((resolve) => {
        const started = Date.now();
        const seen = { videos: 0, iframes: 0, maxReadyState: 0, maxTime: 0, src: '' };
        (function poll() {
          const videos = Array.from(document.querySelectorAll('video'));
          seen.videos = videos.length;
          seen.iframes = document.querySelectorAll('iframe').length;
          for (const v of videos) {
            seen.maxReadyState = Math.max(seen.maxReadyState, v.readyState);
            seen.maxTime = Math.max(seen.maxTime, v.currentTime || 0);
            if (!seen.src && (v.currentSrc || v.src)) seen.src = String(v.currentSrc || v.src).slice(0, 80);
            if (v.readyState >= 3 && v.currentTime > 1 && !v.paused) {
              return resolve({ playing: true, elapsedMs: Date.now() - started, ...seen });
            }
            if (v.paused && v.readyState >= 2 && v.currentTime < 0.5) { try { v.muted = true; v.play().catch(() => {}); } catch (e) {} }
          }
          if (Date.now() - started > 120000) return resolve({ playing: false, elapsedMs: Date.now() - started, ...seen });
          setTimeout(poll, 500);
        })();
      })`;
    let result;
    try {
      result = await wc.executeJavaScript(snippet, true);
    } catch (err) {
      result = { playing: false, error: err && err.message };
    }
    try {
      const shot = await wc.capturePage();
      fs.writeFileSync(path.join(__dirname, '..', 'smoke-play.png'), shot.toPNG());
    } catch {
      // capture facultative
    }
    console.log(`[movix:play] ${JSON.stringify(result)}`);
    console.log(`[movix:play] ${result.playing ? 'LECTURE OK' : 'PAS DE LECTURE'}`);
    return Boolean(result.playing);
  }

  // --- Cycle de vie -----------------------------------------------------------

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('web-contents-created', (_event, contents) => {
    attachNavigationPolicy(contents);
  });

  app.on('window-all-closed', () => app.quit());

  // DNS sécurisé (DNS-over-HTTPS) : même rôle que le DNS 1.1.1.1 de l'app
  // mobile. Les fournisseurs d'accès filtrent certains hébergeurs vidéo en
  // détournant leur DNS (réponses ERR_CERT_AUTHORITY_INVALID /
  // ERR_CONNECTION_RESET) ; la résolution chiffrée via Cloudflare/Google/Quad9
  // contourne ce détournement pour toute l'app (pages, extension, flux).
  function applySecureDns() {
    const enabled = config.secureDnsEnabled;
    try {
      app.configureHostResolver(enabled ? {
        enableBuiltInResolver: true,
        secureDnsMode: 'secure',
        secureDnsServers: [
          'https://cloudflare-dns.com/dns-query',
          'https://dns.google/dns-query',
          'https://dns.quad9.net/dns-query',
        ],
      } : { secureDnsMode: 'off' });
      console.log(`[dns] DNS sécurisé ${enabled ? 'actif (DoH Cloudflare/Google/Quad9)' : 'désactivé'}`);
    } catch (err) {
      console.warn('[dns] configuration impossible :', err && err.message);
    }
  }

  function setSecureDns(enabled) {
    config.set('secureDns', Boolean(enabled));
    applySecureDns();
    refreshMenu();
  }

  app.whenReady().then(async () => {
    applySecureDns();
    loadInjectionCode();
    installWebRequestHooks(session.defaultSession);
    registerIpc();

    createMainWindow();
    loadLocalPage('loading.html');
    if (IS_DEV && process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });

    await resolveAddress();
    loadMirror(0);
    initAutoUpdate();
    console.log(`[adblock] ${adBlocker.enabled ? 'actif' : 'désactivé'} (config/--adblock/MOVIX_ADBLOCK)`);
    adBlocker.load((url, init) => net.fetch(url, init)).catch(() => {});
  }).catch((err) => {
    console.error('[movix] démarrage impossible', err);
    dialog.showErrorBox(APP_NAME, `Démarrage impossible : ${err && err.message ? err.message : err}`);
    app.quit();
  });
}
