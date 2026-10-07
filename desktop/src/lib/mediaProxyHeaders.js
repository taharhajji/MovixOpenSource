'use strict';

/**
 * Règles d'en-têtes par hébergeur, portées de app/src/services/mediaProxyHeaders.ts.
 *
 * Appliquées à deux endroits :
 *  - sur chaque GM_xmlhttpRequest exécuté par le processus principal (lib/gmFetch.js),
 *    comme le fait le pont natif de l'app mobile ;
 *  - sur les requêtes média que le moteur web émet lui-même (<video src>, segments),
 *    via session.webRequest.onBeforeSendHeaders — l'équivalent des règles
 *    declarativeNetRequest de l'extension Chrome.
 *
 * Les valeurs sont celles du relais Python (API/proxiesembed/server.py) et de
 * l'app mobile : les deux chemins doivent présenter le même client à l'amont.
 */

const PROVIDER_SIGNED_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const PROVIDER_SEC_CH_UA =
  '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"';
const PROVIDER_SEC_CH_UA_MOBILE = '?0';
const PROVIDER_SEC_CH_UA_PLATFORM = '"Windows"';
const PROVIDER_ACCEPT_LANGUAGE = 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7';

const PROVIDER_MEDIA_ACCEPT_ENCODING =
  'identity, gzip;q=0, deflate;q=0, br;q=0, zstd;q=0';
const PROVIDER_MEDIA_PATH = /\.(?:m3u8|mpd|mp4|m4v|m4s|ts|aac|m4a|vtt|srt|key)$/i;

const PROVIDER_EXTRACTION_USER_AGENT = 'Mozilla/5.0 Chrome/143.0.0.0';

/** @type {ReadonlyArray<readonly [readonly string[], string]>} */
const PROVIDER_ORIGINS = [
  [
    [
      'lulustream.com', 'luluvdo.com', 'luluvdoo.com', 'luluvid.com', 'lulu.st',
      'streamhihi.com', 'cdn1.site', 'd00ds.site', '732eg54de642sa.sbs',
      '.tnmr.org',
    ],
    'https://lulustream.com',
  ],
  [
    ['veev.to', 'veev.pro', 'poophq.com', 'doods.to', '.veevcdn.co'],
    'https://veev.to',
  ],
  [
    ['vidara.to', 'vidara.so', '.s1q2105.com', '.97bf1.com'],
    'https://vidara.to',
  ],
];

const CLIENT_HINT_HEADERS = ['Sec-Ch-Ua', 'Sec-Ch-Ua-Mobile', 'Sec-Ch-Ua-Platform'];

function matchesHost(hostname, suffix) {
  if (suffix.startsWith('.')) return hostname.endsWith(suffix);
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

function providerOriginFor(hostname) {
  for (const [hosts, origin] of PROVIDER_ORIGINS) {
    if (hosts.some((suffix) => matchesHost(hostname, suffix))) return origin;
  }
  return null;
}

function getHeader(headers, name) {
  const lowered = name.toLowerCase();
  for (const existing of Object.keys(headers)) {
    if (existing.toLowerCase() === lowered) return headers[existing];
  }
  return null;
}

function deleteHeader(headers, name) {
  const lowered = name.toLowerCase();
  for (const existing of Object.keys(headers)) {
    if (existing.toLowerCase() === lowered) delete headers[existing];
  }
}

function setCanonicalHeader(headers, name, value) {
  deleteHeader(headers, name);
  headers[name] = value;
}

/**
 * Hôte d'une URL absolue, en minuscules, sans point final. `null` si illisible.
 */
function hostnameOf(url) {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(String(url || '').trim());
  if (!match) return null;
  const authority = match[1];
  const credentialsEnd = authority.lastIndexOf('@');
  const hostPort = credentialsEnd >= 0 ? authority.slice(credentialsEnd + 1) : authority;
  if (hostPort.startsWith('[')) {
    const end = hostPort.indexOf(']');
    return end < 0 ? null : hostPort.slice(0, end + 1).toLowerCase();
  }
  const portStart = hostPort.indexOf(':');
  const host = portStart >= 0 ? hostPort.slice(0, portStart) : hostPort;
  if (!host) return null;
  return host.toLowerCase().replace(/\.+$/, '');
}

/**
 * Indique si l'URL vise un hébergeur couvert par les règles (sans les appliquer).
 */
function isProviderUrl(url) {
  const hostname = hostnameOf(url);
  if (!hostname) return false;
  return (
    hostname === 'fsvid.lol' || hostname.endsWith('.fsvid.lol')
    || hostname === 'vidzy.org' || hostname.endsWith('.vidzy.org')
    || hostname === 'vidzy.cc' || hostname.endsWith('.vidzy.cc')
    || /(?:^|\.)(uqload\.[a-z]{2,24})$/.test(hostname)
    || providerOriginFor(hostname) !== null
  );
}

/**
 * Retourne une copie des en-têtes avec les règles de l'hébergeur appliquées.
 * Les en-têtes d'entrée peuvent être en n'importe quelle casse.
 *
 * @param {string} url
 * @param {Record<string, string>} input
 * @returns {Record<string, string>}
 */
function applyMediaProxyHeaderRules(url, input) {
  const headers = { ...(input || {}) };
  const hostname = hostnameOf(url);
  if (!hostname) return headers;

  const isFsvidHost = hostname === 'fsvid.lol' || hostname.endsWith('.fsvid.lol');
  const isVidzyHost =
    hostname === 'vidzy.org' || hostname.endsWith('.vidzy.org')
    || hostname === 'vidzy.cc' || hostname.endsWith('.vidzy.cc');
  const uqloadMatch = /(?:^|\.)(uqload\.[a-z]{2,24})$/.exec(hostname);
  const uqloadRoot = uqloadMatch ? uqloadMatch[1] : null;
  const providerOrigin = providerOriginFor(hostname);
  if (!isFsvidHost && !isVidzyHost && !uqloadRoot && !providerOrigin) {
    return headers;
  }

  if (isFsvidHost) {
    const origin = hostname === 'fsvid.lol' ? 'https://fs13.lol' : 'https://fsvid.lol';
    setCanonicalHeader(headers, 'Origin', origin);
    setCanonicalHeader(headers, 'Referer', `${origin}/`);
  } else if (isVidzyHost) {
    setCanonicalHeader(headers, 'Origin', 'https://vidzy.org');
    setCanonicalHeader(headers, 'Referer', 'https://vidzy.org/');
  } else if (uqloadRoot) {
    setCanonicalHeader(headers, 'Origin', `https://${uqloadRoot}`);
    setCanonicalHeader(headers, 'Referer', `https://${uqloadRoot}/`);
  } else if (providerOrigin) {
    setCanonicalHeader(headers, 'Origin', providerOrigin);
    setCanonicalHeader(headers, 'Referer', `${providerOrigin}/`);
  }

  if (providerOrigin) {
    setCanonicalHeader(headers, 'User-Agent', PROVIDER_EXTRACTION_USER_AGENT);
    setCanonicalHeader(headers, 'Accept-Language', PROVIDER_ACCEPT_LANGUAGE);
    for (const hint of CLIENT_HINT_HEADERS) {
      const value = getHeader(headers, hint);
      if (value) setCanonicalHeader(headers, hint, value);
      else deleteHeader(headers, hint);
    }
  } else {
    if (PROVIDER_MEDIA_PATH.test(url.split(/[?#]/, 1)[0])) {
      setCanonicalHeader(headers, 'Accept-Encoding', PROVIDER_MEDIA_ACCEPT_ENCODING);
    } else {
      deleteHeader(headers, 'Accept-Encoding');
    }
    setCanonicalHeader(headers, 'Accept-Language', PROVIDER_ACCEPT_LANGUAGE);
    setCanonicalHeader(headers, 'Sec-Ch-Ua', PROVIDER_SEC_CH_UA);
    setCanonicalHeader(headers, 'Sec-Ch-Ua-Mobile', PROVIDER_SEC_CH_UA_MOBILE);
    setCanonicalHeader(headers, 'Sec-Ch-Ua-Platform', PROVIDER_SEC_CH_UA_PLATFORM);
    setCanonicalHeader(headers, 'User-Agent', PROVIDER_SIGNED_USER_AGENT);
  }
  setCanonicalHeader(headers, 'Sec-Fetch-Site', 'cross-site');
  setCanonicalHeader(headers, 'Sec-Fetch-Mode', 'cors');
  setCanonicalHeader(headers, 'Sec-Fetch-Dest', 'empty');
  return headers;
}

/**
 * Retire les en-têtes `Sec-Fetch-*` : le pont mobile les pose pour un fetch
 * React Native, mais la pile réseau de Chromium les calcule elle-même et
 * refuse une valeur fournie (`Sec-Fetch-Mode` → net::ERR_INVALID_ARGUMENT).
 */
function stripSecFetchHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (/^sec-fetch-/i.test(name)) continue;
    out[name] = value;
  }
  return out;
}

module.exports = {
  applyMediaProxyHeaderRules,
  hostnameOf,
  isProviderUrl,
  stripSecFetchHeaders,
  PROVIDER_SIGNED_USER_AGENT,
};
