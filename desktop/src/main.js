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
const { applyMediaProxyHeaderRules, isProviderUrl, hostnameOf } = require('./lib/mediaProxyHeaders');
const { classifyExternalUrl, isAllowedInApp, isHttpUrl, isSiteHost } = require('./lib/navigationPolicy');
const { buildInjectedJavaScript } = require('./injection/bridge-runtime');
const { buildMenu } = require('./lib/menu');
const { AdBlocker } = require('./lib/adBlock');

const APP_ID = 'com.movix.desktop';
const IS_DEV = !app.isPackaged || process.argv.includes('--dev');
const MIRROR_DOWN_STATUSES = new Set([500, 502, 504, 520, 521, 522, 523, 524, 525, 526, 530]);
const ADDRESS_CACHE_FILE = 'address-cache.json';
const USERSCRIPT_PATH = path.join(__dirname, '..', 'resources', 'movix.user.js');
const ICON_PATH = path.join(__dirname, '..', 'build', 'icon.png');
const PAGES_DIR = path.join(__dirname, 'pages');

// ---------------------------------------------------------------------------
// Démarrage : instance unique, identité Windows, commutateurs Chromium
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
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
    + `Chrome/${process.versions.chrome} Safari/537.36 MovixDesktop/${app.getVersion()}`;

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
      injectionCode = buildInjectedJavaScript({ version: app.getVersion(), userscriptSource });
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

  function showErrorPage() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    currentMirrorUrl = '';
    refreshMenu();
    mainWindow.loadFile(path.join(PAGES_DIR, 'error.html')).catch(() => {});
  }

  async function restartFromScratch() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.loadFile(path.join(PAGES_DIR, 'loading.html')).catch(() => {});
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
      backgroundColor: '#000000',
      title: 'Movix',
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
      wc.once('did-finish-load', () => runSmokeTest(wc));
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
      if (adBlocker.shouldBlock({ url: details.url, resourceType: details.resourceType, referrer: details.referrer })) {
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
      callback({ requestHeaders: applyMediaProxyHeaderRules(details.url, details.requestHeaders) });
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
    const mirrors = chain.map((url) => ({ url, label: url.replace(/^https?:\/\//, '') }));
    const menu = buildMenu({
      reload: () => mainWindow && mainWindow.webContents.reload(),
      home: () => loadMirror(chainIndex >= 0 && chainIndex < chain.length ? chainIndex : 0),
      back: () => mainWindow && mainWindow.webContents.navigationHistory.goBack(),
      forward: () => mainWindow && mainWindow.webContents.navigationHistory.goForward(),
      mirrors,
      currentMirrorUrl,
      siteForced: Boolean(config.forcedSiteUrl),
      adBlockEnabled: adBlocker.enabled,
      toggleAdBlock: setAdBlock,
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
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'À propos de Movix',
      message: `Movix Desktop ${app.getVersion()}`,
      detail: [
        `Site : ${currentMirrorUrl || '(aucun)'}${config.forcedSiteUrl ? ' (imposé)' : ''}`,
        `Miroirs connus : ${chain.length} (source : ${address ? address.source : '?'})`,
        (() => {
          const s = adBlocker.summary();
          return s.enabled
            ? `Blocage des pubs : actif (moteur ${s.engine}) — ${s.requests} requêtes et ${s.popups} popups bloqués${s.top.length ? ` · ${s.top.join(', ')}` : ''}`
            : 'Blocage des pubs : désactivé';
        })(),
        `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
        '',
        'Licence CC BY-NC 4.0 — github.com/movixstream/MovixOpenSource',
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
        message: `Movix ${info.version} est téléchargé.`,
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
          message: `Movix ${app.getVersion()} est à jour.`,
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
        const finish = (extra) => adProbe.then((adResult) => resolve({ ...out, adProbe: adResult, ...extra }));
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
    if (result) result.adBlock = adBlocker.summary();
    const adOk = !adBlocker.enabled || (result && result.adProbe === 'bloqué' && result.adPopup === 'neutralisé');
    const ok = result && result.bridge && result.gm === 'function' && result.userscript
      && result.probe && result.probe.status === 200 && adOk;
    console.log(`[movix:smoke] ${JSON.stringify(result)}`);
    console.log(`[movix:smoke] ${ok ? 'OK' : 'ÉCHEC'}`);
    setTimeout(() => app.exit(ok ? 0 : 1), 200);
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

  app.whenReady().then(async () => {
    loadInjectionCode();
    installWebRequestHooks(session.defaultSession);
    registerIpc();

    createMainWindow();
    mainWindow.loadFile(path.join(PAGES_DIR, 'loading.html')).catch(() => {});
    if (IS_DEV && process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });

    await resolveAddress();
    loadMirror(0);
    initAutoUpdate();
    console.log(`[adblock] ${adBlocker.enabled ? 'actif' : 'désactivé'} (config/--adblock/MOVIX_ADBLOCK)`);
    adBlocker.load((url, init) => net.fetch(url, init)).catch(() => {});
  }).catch((err) => {
    console.error('[movix] démarrage impossible', err);
    dialog.showErrorBox('Movix', `Démarrage impossible : ${err && err.message ? err.message : err}`);
    app.quit();
  });
}
