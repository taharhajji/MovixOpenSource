'use strict';

/**
 * Politique de navigation de l'application de bureau.
 *
 * Reste dans la fenêtre : les domaines Movix (miroirs compris), un hôte
 * personnalisé (--site / config.json, pour pointer un serveur local ou de
 * staging), et les fournisseurs OAuth (Discord, Google) dont le flux revient
 * ensuite sur `${origin}/auth`. Tout le reste (régies pub, Telegram, liens
 * externes) s'ouvre dans le navigateur par défaut.
 */

const MOVIX_HOST_RE = /(?:^|\.)movix\.[a-z0-9-]{2,24}$/i;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const AUTH_HOSTS = [
  'discord.com',
  'discordapp.com',
  'accounts.google.com',
  'accounts.youtube.com',
  'myaccount.google.com',
  'google.com',
  'gstatic.com',
  'challenges.cloudflare.com',
];

// Destinations externes légitimes qu'un clic de l'utilisateur peut ouvrir dans
// le navigateur même quand le blocage des pubs est actif. Tout autre hôte
// externe est alors considéré comme une pub (smartlink, popunder) et ignoré.
const SAFE_EXTERNAL_HOSTS = [
  't.me',
  'telegram.me',
  'telegram.org',
  'github.com',
  'discord.gg',
  'discord.com',
  'youtube.com',
  'youtu.be',
  'themoviedb.org',
  'wikipedia.org',
  'rentry.co',
  'tampermonkey.net',
  'mozilla.org',
  'google.com',
];

function hostMatches(hostname, pattern) {
  return hostname === pattern || hostname.endsWith(`.${pattern}`);
}

function isSafeExternalHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return SAFE_EXTERNAL_HOSTS.some((pattern) => hostMatches(host, pattern));
}

/**
 * Domaine Movix (movix.<tld>, sous-domaines compris) ou hôte local de dev.
 */
function isMovixHost(hostname) {
  if (!hostname) return false;
  const host = String(hostname).toLowerCase();
  return MOVIX_HOST_RE.test(host) || LOCAL_HOSTS.has(host);
}

function isAuthHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return AUTH_HOSTS.some((pattern) => hostMatches(host, pattern));
}

/**
 * Hôte considéré comme « le site » : Movix, local, ou l'hôte personnalisé.
 */
function isSiteHost(hostname, extraHosts = []) {
  if (isMovixHost(hostname)) return true;
  const host = String(hostname || '').toLowerCase();
  return extraHosts.some((extra) => extra && host === String(extra).toLowerCase());
}

/**
 * Une navigation de premier niveau vers cette URL peut-elle rester dans l'app ?
 */
function isAllowedInApp(url, extraHosts = []) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return false;
  }
  if (parsed.protocol === 'file:') return true;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return isSiteHost(parsed.hostname, extraHosts) || isAuthHost(parsed.hostname);
}

function isHttpUrl(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Classe une URL cible : 'app' (reste dans la fenêtre), 'external' (navigateur
 * par défaut) ou 'blocked' (ignorée : blocage des pubs actif et hôte non sûr).
 */
function classifyExternalUrl(url, { extraHosts = [], adBlockEnabled = false } = {}) {
  if (isAllowedInApp(url, extraHosts)) return 'app';
  if (!isHttpUrl(url)) return 'external';
  if (!adBlockEnabled) return 'external';
  let hostname = '';
  try {
    hostname = new URL(String(url)).hostname;
  } catch {
    return 'blocked';
  }
  return isSafeExternalHost(hostname) ? 'external' : 'blocked';
}

module.exports = {
  AUTH_HOSTS,
  SAFE_EXTERNAL_HOSTS,
  classifyExternalUrl,
  isAllowedInApp,
  isAuthHost,
  isHttpUrl,
  isMovixHost,
  isSafeExternalHost,
  isSiteHost,
};
