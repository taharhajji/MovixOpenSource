'use strict';

/**
 * Blocage des publicités (phase de test de l'app, avant publication).
 *
 * Trois couches, toutes pilotées par le même interrupteur (`enabled`) :
 *  1. Liste intégrée de régies / popunders / traqueurs : disponible hors ligne,
 *     dès le démarrage, même si le moteur de filtres n'a pas pu se charger.
 *  2. Moteur de filtres Ghostery (@ghostery/adblocker) avec les listes
 *     EasyList + EasyPrivacy préconstruites, téléchargées une fois puis mises
 *     en cache sur disque (userData/adblock-engine.bin). Consulté depuis le
 *     seul hook `session.webRequest.onBeforeRequest` de l'app (main.js).
 *  3. Popups / navigations sortantes vers des hôtes non sûrs : neutralisées
 *     (voir navigationPolicy.isSafeExternalHost et bridge-runtime window.open).
 *
 * Jamais bloqué : les hôtes du site (Movix, hôte imposé), l'OAuth, TMDB, les
 * résolveurs de miroirs — un faux positif y casserait l'app, pas une pub.
 */

const path = require('node:path');
const fs = require('node:fs');
const { hostnameOf, isProviderUrl } = require('./mediaProxyHeaders');

// Types de ressources jamais bloqués : les flux vidéo (segments HLS, MP4) et
// les WebSockets (WatchParty) ne sont pas des pubs, même si un hébergeur
// figure dans une liste de filtres pour ses pages.
const NEVER_BLOCK_TYPES = new Set(['media', 'webSocket', 'websocket', 'mainFrame', 'main_frame']);

// Hébergeurs vidéo que les extracteurs de l'extension interrogent : EasyList
// en liste plusieurs (ils servent eux-mêmes des pubs), mais depuis l'app ce
// sont des sources, pas des régies. Suffixes de domaine (sous-domaines inclus).
const VIDEO_HOST_SUFFIXES = Object.freeze([
  'vidmoly.me', 'vidmoly.net', 'vidmoly.to', 'vidmoly.biz', 'vidmoly.org',
  'uqload.is', 'uqload.cx', 'uqload.vc', 'uqload.net', 'uqload.io', 'uqload.co',
  'voe.sx', 'voe-unblock.com', 'voe-un-block.com',
  'dood.li', 'dood.to', 'dood.re', 'dood.so', 'dood.wf', 'dood.pm', 'dood.yt', 'doodstream.com', 'dsvplay.com', 'd0o0d.com', 'ds2play.com', 'ds2video.com', 'dooood.com', 'do7go.com',
  'dropload.io', 'dropload.tv',
  'streamtape.com', 'streamtape.to', 'streamtape.net', 'streamtape.xyz', 'strtape.cloud', 'tapecontent.net',
  'mixdrop.co', 'mixdrop.ag', 'mixdrop.to', 'mixdrop.ps', 'mixdrop.sx', 'mxdrop.to',
  'filemoon.sx', 'filemoon.to', 'filemoon.in', 'filemoon.nl',
  'vidhide.com', 'vidhidepro.com', 'vidhidevip.com', 'vidhideplus.com',
  'vidguard.to', 'vgembed.com', 'vembed.net',
  'sibnet.ru', 'video.sibnet.ru',
  'streamwish.to', 'streamwish.com', 'swhoi.com', 'awish.pro', 'wishfast.top',
  'seekstreaming.com', 'cinejoy.app',
  'vidzy.org', 'vidzy.cc', 'fsvid.lol', 'fs13.lol',
  'lulustream.com', 'luluvdo.com', 'luluvdoo.com', 'luluvid.com', 'lulu.st', 'tnmr.org',
  'veev.to', 'veev.pro', 'veevcdn.co', 'poophq.com',
  'vidara.to', 'vidara.so',
  'vidsrc.cc', 'vidsrc.su', 'vidsrc.wtf', 'videasy.net',
]);

function isVideoHost(hostname) {
  return VIDEO_HOST_SUFFIXES.some((suffix) => hostMatches(hostname, suffix));
}

const BUILTIN_AD_DOMAINS = Object.freeze([
  // Google / grandes régies
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'googletagservices.com',
  'google-analytics.com', 'googletagmanager.com', 'adsense.google.com', 'admob.com',
  'adnxs.com', 'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com', 'mgid.com',
  'revcontent.com', 'adsco.re', 'adskeeper.co.uk', 'bidvertiser.com', 'smartadserver.com',
  'rubiconproject.com', 'pubmatic.com', 'openx.net', 'casalemedia.com', 'adform.net',
  'amazon-adsystem.com', 'media.net', 'yieldmo.com', 'sharethrough.com', 'teads.tv',
  // Régies « streaming » / popunders / smartlinks
  'adsterra.com', 'adsterratech.com', 'highperformanceformat.com', 'profitableratecpm.com',
  'effectivegatecpm.com', 'propellerads.com', 'propellerclick.com', 'propu.sh', 'monetag.com',
  'popads.net', 'popcash.net', 'popunder.net', 'exoclick.com', 'exosrv.com', 'realsrv.com',
  'magsrv.com', 'juicyads.com', 'juicyads.net', 'trafficjunky.com', 'trafficjunky.net',
  'hilltopads.com', 'hilltopads.net', 'clickadu.com', 'adcash.com', 'a-ads.com', 'zeropark.com',
  'richads.com', 'admaven.com', 'ad-maven.com', 'trafficstars.com', 'tsyndicate.com',
  'ero-advertising.com', 'plugrush.com', 'trafficfactory.biz', 'onclickads.net', 'onclicka.com',
  'adtng.com', 'syndicatedsearch.goog', 'pushame.com', 'pushwoosh.com', 'push.house',
  'clickaine.com', 'adspyglass.com', 'adsrvr.org', 'bebi.com', 'bebi.io', 'evadav.com',
  'galaksion.com', 'mybestmv.com', 'adtelligent.com', 'adoperator.com', 'trafficshop.com',
  'tsyndicate.net', 'runative-syndicate.com', 'runative.com', 'engine.phn.doublepimp.com',
  'doublepimp.com', 'cpmstar.com', 'ad.plus', 'ad-plus.com', 'adplxmd.com', 'adbetclickin.pink',
  'bidgear.com', 'buysellads.com', 'carbonads.com', 'carbonads.net', 'coinzilla.com',
  'cointraffic.io', 'ad.a-ads.com', 'adshares.net', 'adx1.com', 'adyoulike.com', 'adroll.com',
  'yandex.ru/ads', 'an.yandex.ru', 'mc.yandex.ru', 'yadro.ru', 'adriver.ru',
  // Traqueurs / mesure
  'hotjar.com', 'mouseflow.com', 'fullstory.com', 'clarity.ms', 'scorecardresearch.com',
  'quantserve.com', 'chartbeat.com', 'newrelic.com', 'nr-data.net', 'facebook.net',
  'connect.facebook.net', 'pixel.facebook.com', 'ads-twitter.com', 'analytics.twitter.com',
  'bat.bing.com', 'matomo.cloud', 'plausible.io', 'umami.is', 'cloudfront.net/ads',
  'histats.com', 'statcounter.com', 'addthis.com', 'sharethis.com', 'onesignal.com',
]);

// Hôtes qu'un faux positif casserait : jamais bloqués, quelle que soit la liste.
const NEVER_BLOCK_SUFFIXES = Object.freeze([
  'themoviedb.org', 'tmdb.org', 'discord.com', 'discordapp.com', 'discord.gg',
  'accounts.google.com', 'gstatic.com', 'googleapis.com', 'googleusercontent.com',
  'challenges.cloudflare.com', 'cloudflare.com', 'rentry.co', 'github.com', 'githubusercontent.com',
  'bestdebrid.com', 'jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com',
]);

function hostMatches(hostname, suffix) {
  if (!hostname || !suffix) return false;
  if (suffix.includes('/')) return false; // entrée « hôte/chemin » : traitée par matchesPathEntry
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

function matchesPathEntry(url, entry) {
  if (!entry.includes('/')) return false;
  const [host, ...rest] = entry.split('/');
  const hostname = hostnameOf(url);
  if (!hostMatches(hostname, host)) return false;
  const pathPrefix = `/${rest.join('/')}`;
  try {
    return new URL(url).pathname.startsWith(pathPrefix);
  } catch {
    return false;
  }
}

function isBuiltinAdUrl(url) {
  const hostname = hostnameOf(url);
  if (!hostname) return false;
  return BUILTIN_AD_DOMAINS.some((entry) => hostMatches(hostname, entry) || matchesPathEntry(url, entry));
}

function isNeverBlockedHost(hostname) {
  return NEVER_BLOCK_SUFFIXES.some((suffix) => hostMatches(hostname, suffix));
}

class AdBlocker {
  /**
   * @param {object} options
   * @param {string} options.cacheDir            dossier du cache du moteur
   * @param {(hostname: string) => boolean} options.isSiteHost
   * @param {{ log: Function, warn: Function }} [options.log]
   */
  constructor({ cacheDir, isSiteHost, log = console }) {
    this.cacheDir = cacheDir;
    this.isSiteHost = isSiteHost || (() => false);
    this.log = log;
    this.enabled = true;
    this.engine = null;
    this.engineSource = 'aucun';
    this.loading = null;
    this.stats = { requests: 0, popups: 0, byHost: new Map() };
  }

  get cachePath() {
    return path.join(this.cacheDir, 'adblock-engine.bin');
  }

  /**
   * Charge le moteur de filtres (cache disque, sinon téléchargement des listes).
   * Ne lève jamais : sans moteur, la liste intégrée reste active.
   *
   * @param {(url: string, init?: object) => Promise<Response>} fetchImpl
   * @param {{ engineFactory?: Function }} [deps]  injection pour les tests
   */
  load(fetchImpl, deps = {}) {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const cachePath = this.cachePath;
      const cacheExisted = fs.existsSync(cachePath);
      try {
        const factory = deps.engineFactory || (async () => {
          const { FiltersEngine } = require('@ghostery/adblocker');
          return FiltersEngine.fromPrebuiltAdsAndTracking(fetchImpl, {
            path: cachePath,
            read: (p) => fs.promises.readFile(p),
            write: (p, buffer) => fs.promises.writeFile(p, buffer),
          });
        });
        this.engine = await factory();
        this.engineSource = cacheExisted ? 'cache' : 'réseau';
        this.log.log(`[adblock] moteur de filtres chargé (${this.engineSource})`);
      } catch (err) {
        this.engine = null;
        this.engineSource = 'indisponible';
        this.log.warn('[adblock] moteur de filtres indisponible, liste intégrée seule :', err && err.message);
      }
      return { engine: Boolean(this.engine), source: this.engineSource };
    })();
    return this.loading;
  }

  /**
   * Décision pour une requête réseau (hook onBeforeRequest).
   * @param {{ url: string, resourceType?: string, referrer?: string }} details
   */
  shouldBlock(details) {
    if (!this.enabled) return false;
    // Requêtes du processus principal (GM_xmlhttpRequest de l'extension,
    // résolution des miroirs, mises à jour) : jamais filtrées, comme les
    // requêtes Tampermonkey échappent à uBlock.
    if (details.fromMainProcess) return false;
    if (NEVER_BLOCK_TYPES.has(String(details.resourceType || ''))) return false;
    const url = String(details.url || '');
    const hostname = hostnameOf(url);
    if (!hostname) return false;
    if (this.isSiteHost(hostname) || isNeverBlockedHost(hostname)) return false;
    // Hébergeurs vidéo connus de l'extension : des sources, pas des régies.
    if (isProviderUrl(url) || isVideoHost(hostname)) return false;

    let blocked = isBuiltinAdUrl(url);
    if (!blocked && this.engine) {
      try {
        const { Request } = require('@ghostery/adblocker');
        const request = Request.fromRawDetails({
          url,
          type: details.resourceType || 'other',
          sourceUrl: details.referrer || '',
        });
        const result = this.engine.match(request);
        blocked = Boolean(result && result.match);
      } catch {
        blocked = false;
      }
    }
    if (blocked) this._record(hostname, 'requests');
    return blocked;
  }

  /** Popup ou navigation sortante neutralisée. */
  recordBlockedPopup(url) {
    const hostname = hostnameOf(url) || '?';
    this._record(hostname, 'popups');
  }

  _record(hostname, kind) {
    this.stats[kind] += 1;
    this.stats.byHost.set(hostname, (this.stats.byHost.get(hostname) || 0) + 1);
  }

  summary() {
    const top = [...this.stats.byHost.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([host, count]) => `${host} (${count})`);
    return {
      enabled: this.enabled,
      engine: this.engineSource,
      requests: this.stats.requests,
      popups: this.stats.popups,
      top,
    };
  }
}

module.exports = {
  AdBlocker,
  BUILTIN_AD_DOMAINS,
  NEVER_BLOCK_SUFFIXES,
  VIDEO_HOST_SUFFIXES,
  isBuiltinAdUrl,
  isNeverBlockedHost,
  isVideoHost,
};
