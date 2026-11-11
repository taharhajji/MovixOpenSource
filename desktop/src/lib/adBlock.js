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

// --- Mode strict des lecteurs externes -----------------------------------------
// Les lecteurs en iframe chargent leurs régies depuis des domaines jetables,
// renouvelés en permanence et donc absents des listes de filtres. Dans un
// lecteur externe, on inverse la logique : seuls le site du lecteur, les
// hébergeurs vidéo et quelques bibliothèques connues peuvent charger scripts
// et sous-cadres ; les autres appels tiers ne passent que s'ils ressemblent à
// de la vidéo.
const EMBED_LIBRARY_SUFFIXES = [
  'jsdelivr.net', 'cloudflare.com', 'unpkg.com', 'jquery.com', 'googleapis.com', 'gstatic.com',
  'bootstrapcdn.com', 'fontawesome.com', 'plyr.io', 'zencdn.net', 'jwpcdn.com', 'jwplayer.com',
  'jwplatform.com', 'hcaptcha.com', 'recaptcha.net', 'google.com', 'tmdb.org', 'themoviedb.org',
  'dashjs.org', 'bitmovin.com', 'fluidplayer.com', 'cloudflareinsights.com',
];
const TWO_LEVEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'com.br', 'com.au', 'co.jp', 'co.in', 'com.tr', 'com.mx', 'co.za', 'com.ar', 'co.kr', 'com.cn',
]);
const MEDIA_PATH = /\.(m3u8|mpd|ts|m4s|m4a|m4v|mp4|mkv|webm|aac|mp3|vtt|srt|ass|key|jpg|jpeg|png|webp|gif)$/i;
const PLAYLIST_PATH = /\.(m3u8|mpd)$/i;
const STRICT_BLOCKED_TYPES = new Set(['script', 'subFrame', 'object', 'ping', 'other', 'cspReport']);

/** Domaine enregistrable approché (« u14.vidzy.org » → « vidzy.org »). */
function siteOf(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.+$/, '');
  if (!host || /^\d+(\.\d+){3}$/.test(host) || host.includes(':')) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join('.');
  return TWO_LEVEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

function isEmbedLibraryHost(hostname) {
  return EMBED_LIBRARY_SUFFIXES.some((suffix) => hostMatches(hostname, suffix));
}

function pathnameOf(url) {
  try {
    return new URL(String(url)).pathname;
  } catch {
    return '';
  }
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
    // Mode strict des lecteurs externes, et sites vidéo appris en cours de session.
    this.strictEmbeds = true;
    this.mediaSites = new Set();
  }

  /**
   * Requête émise depuis un lecteur externe (iframe d'un site tiers) : bloquée
   * si elle vise un tiers inconnu. Appelée après shouldBlock, pour les
   * requêtes que les listes ont laissées passer.
   *
   * @param {object} details
   * @param {string} details.url
   * @param {string} details.resourceType   type Electron (script, subFrame, xhr…)
   * @param {string} details.requesterHost  hôte du cadre qui émet la requête
   * @param {string} details.rootHost       hôte du lecteur (iframe posée par le site)
   */
  shouldBlockEmbedRequest(details) {
    if (!this.enabled || !this.strictEmbeds) return false;
    const type = String(details.resourceType || '');
    if (NEVER_BLOCK_TYPES.has(type)) return false;
    const url = String(details.url || '');
    const hostname = hostnameOf(url);
    if (!hostname) return false;
    const targetSite = siteOf(hostname);
    const pathname = pathnameOf(url);
    // Un site qui sert une playlist est un CDN vidéo : ses segments passeront
    // ensuite quelle que soit leur extension.
    if (PLAYLIST_PATH.test(pathname)) this.mediaSites.add(targetSite);
    if (this.isSiteHost(hostname) || isNeverBlockedHost(hostname)) return false;
    if (isProviderUrl(url) || isVideoHost(hostname) || isEmbedLibraryHost(hostname)) return false;
    if (targetSite === siteOf(details.requesterHost) || targetSite === siteOf(details.rootHost)) return false;
    if (this.mediaSites.has(targetSite)) return false;

    let blocked = false;
    if (STRICT_BLOCKED_TYPES.has(type)) blocked = true;
    else if (type === 'xhr') blocked = !MEDIA_PATH.test(pathname);
    if (blocked) this._record(hostname, 'requests');
    return blocked;
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
  EMBED_LIBRARY_SUFFIXES,
  siteOf,
  BUILTIN_AD_DOMAINS,
  NEVER_BLOCK_SUFFIXES,
  VIDEO_HOST_SUFFIXES,
  isBuiltinAdUrl,
  isNeverBlockedHost,
  isVideoHost,
};
