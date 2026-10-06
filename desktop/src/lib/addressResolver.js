'use strict';

/**
 * Résolution de l'adresse courante de Movix, portée de
 * app/src/services/addressResolver.ts :
 *
 *   rentry.co/movix  ->  https://<hôte>/address.json  ->  config en cache  ->  liste codée en dur
 *
 * Aucune dépendance Electron : `fetchImpl` est injecté (net.fetch en prod,
 * un faux dans les tests).
 */

const FALLBACK_CONFIG = Object.freeze({
  RENTRY_URL: 'https://rentry.co/movix',
  RESOLVER_HOSTS: ['movix.online'],
  PRIMARY_URL: 'https://movix.luxe',
  MIRRORS: [
    'https://movix.college',
    'https://movix.men',
    'https://movix.fun',
    'https://movix.show',
    'https://movix.date',
    'https://movix.chat',
    'https://movix.golf',
    'https://movix.cloud',
    'https://movix.cash',
  ],
  GITHUB_URL: 'https://github.com/movixstream/MovixOpenSource',
  TELEGRAM_URL: 'https://t.me/movix_site',
  TIMEOUT_MS: 5000,
});

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

function isString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isValidHostname(host) {
  if (!HOSTNAME_RE.test(host)) return false;
  if (host === 'rentry.co' || host.endsWith('.rentry.co')) return false;
  return true;
}

/**
 * Deux formats acceptés (comme public/sw.js) :
 *  - JSON : {"mirrors": ["host", ...]}
 *  - HTML rentry : hôtes des <a href> du premier <article>
 */
function parseRentry(text) {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed.mirrors)) {
      for (const m of parsed.mirrors) {
        if (typeof m === 'string') {
          const host = m.trim().toLowerCase();
          if (isValidHostname(host)) return host;
        }
      }
      return null;
    }
  } catch {
    // HTML
  }
  const articleMatch = text.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  const scope = articleMatch ? articleMatch[1] : text;
  const hrefRe = /href=["']https?:\/\/([^/"'\s?#]+)/gi;
  let match;
  while ((match = hrefRe.exec(scope)) !== null) {
    const host = match[1].trim().toLowerCase();
    if (isValidHostname(host)) return host;
  }
  return null;
}

function normalizeAddressJson(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const primaryUrl = raw.primary && raw.primary.url;
  if (!isString(primaryUrl)) return null;
  if (!isString(raw.github)) return null;
  if (!isString(raw.telegram)) return null;

  const active = Array.isArray(raw.active) ? raw.active : [];
  const mirrors = [];
  for (const m of active) {
    const url = m && m.url;
    if (isString(url) && url !== primaryUrl && !mirrors.includes(url)) {
      mirrors.push(url);
    }
  }
  return { primaryUrl, mirrors, githubUrl: raw.github, telegramUrl: raw.telegram };
}

const HARDCODED_FALLBACK = Object.freeze({
  primaryUrl: FALLBACK_CONFIG.PRIMARY_URL,
  mirrors: FALLBACK_CONFIG.MIRRORS,
  githubUrl: FALLBACK_CONFIG.GITHUB_URL,
  telegramUrl: FALLBACK_CONFIG.TELEGRAM_URL,
});

/**
 * Ajoute en fin de chaîne les miroirs connus absents de la config : une config
 * en cache périmée garde ainsi des domaines de secours.
 */
function withKnownMirrors(config) {
  const seen = new Set([config.primaryUrl, ...config.mirrors]);
  const extra = [FALLBACK_CONFIG.PRIMARY_URL, ...FALLBACK_CONFIG.MIRRORS].filter(
    (url) => !seen.has(url),
  );
  return { ...config, mirrors: [...config.mirrors, ...extra] };
}

function sanitizeCached(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (!isString(parsed.primaryUrl) || !Array.isArray(parsed.mirrors)) return null;
  if (!isString(parsed.githubUrl) || !isString(parsed.telegramUrl)) return null;
  return {
    primaryUrl: parsed.primaryUrl,
    mirrors: parsed.mirrors.filter(isString),
    githubUrl: parsed.githubUrl,
    telegramUrl: parsed.telegramUrl,
  };
}

async function fetchWithTimeout(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} deps
 * @param {(url: string, init?: object) => Promise<Response>} deps.fetchImpl
 * @param {() => Promise<object|null>|object|null} [deps.readCache]
 * @param {(config: object) => Promise<void>|void} [deps.writeCache]
 * @param {(msg: string, err?: unknown) => void} [deps.warn]
 * @param {number} [deps.timeoutMs]
 */
async function resolveAddressConfig(deps) {
  const {
    fetchImpl,
    readCache = () => null,
    writeCache = () => {},
    warn = () => {},
    timeoutMs = FALLBACK_CONFIG.TIMEOUT_MS,
  } = deps;

  let rentryHost = null;
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${FALLBACK_CONFIG.RENTRY_URL}?_=${Date.now()}`,
      timeoutMs,
    );
    if (!res.ok) throw new Error(`rentry status ${res.status}`);
    rentryHost = parseRentry(await res.text());
    if (!rentryHost) throw new Error('rentry: aucun hôte valide');
  } catch (err) {
    warn('[addressResolver] rentry injoignable', err);
  }

  const hosts = [rentryHost, ...FALLBACK_CONFIG.RESOLVER_HOSTS].filter(
    (host, i, all) => !!host && all.indexOf(host) === i,
  );

  for (const host of hosts) {
    try {
      const res = await fetchWithTimeout(
        fetchImpl,
        `https://${host}/address.json?_=${Date.now()}`,
        timeoutMs,
      );
      if (!res.ok) throw new Error(`address.json status ${res.status}`);
      const normalized = normalizeAddressJson(await res.json());
      if (!normalized) throw new Error('address.json: forme invalide');
      try {
        await writeCache(normalized);
      } catch {
        // le cache est un confort, pas une condition
      }
      return { ...withKnownMirrors(normalized), source: `address.json@${host}` };
    } catch (err) {
      warn(`[addressResolver] address.json injoignable sur ${host}`, err);
    }
  }

  let cached = null;
  try {
    cached = sanitizeCached(await readCache());
  } catch {
    cached = null;
  }
  if (cached) return { ...withKnownMirrors(cached), source: 'cache' };
  return { ...withKnownMirrors(HARDCODED_FALLBACK), source: 'fallback' };
}

module.exports = {
  FALLBACK_CONFIG,
  HARDCODED_FALLBACK,
  normalizeAddressJson,
  parseRentry,
  resolveAddressConfig,
  withKnownMirrors,
};
