'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Configuration locale de l'application, dans `%APPDATA%/Movix/config.json`.
 *
 * Champs :
 *  - siteUrl      : URL imposée du site (ex. http://localhost:3000 pour la team,
 *                   ou un serveur de staging). Vide = résolution automatique des
 *                   miroirs. Surchargeable par `--site=<url>` ou MOVIX_SITE_URL.
 *  - lastMirror   : dernier miroir qui a répondu, essayé en premier au démarrage.
 *  - windowBounds : position/taille restaurées au lancement.
 *  - zoomFactor   : zoom de la page.
 */

const DEFAULTS = Object.freeze({
  siteUrl: '',
  lastMirror: '',
  windowBounds: null,
  zoomFactor: 1,
  // Phase de test avant publication : blocage total des pubs activé par défaut.
  // Surchargeable par `--adblock=off` ou MOVIX_ADBLOCK=0.
  adBlock: true,
  // Masque la marque du site dans la page (logo du header/footer, images,
  // intro animée) et la remplace par le nom de l'app. MOVIX_SITE_BRANDING=1
  // ou --site-branding=on pour la réafficher.
  hideSiteBranding: true,
  // DNS-over-HTTPS (Cloudflare/Google/Quad9) pour contourner le filtrage DNS
  // des fournisseurs d'accès, comme le DNS 1.1.1.1 de l'app mobile.
  // MOVIX_SECURE_DNS=0 ou --secure-dns=off pour le couper.
  secureDns: true,
  // Statut VIP local (phase de test) : le site se comporte comme pour un
  // compte VIP (pas de popup pub, sources et réglages VIP visibles) sans code
  // en base. Les fonctions VIP servies par l'API restent soumises à un vrai
  // code. MOVIX_LOCAL_VIP=0 ou --local-vip=off pour le couper.
  localVip: true,
  // Source SwiftFlux : la seule dont la lecture exige la vérification « je ne
  // suis pas un robot » (Turnstile) côté API. 'last' = reléguée en fin de
  // priorité (plus de vérification tant qu'une autre source existe),
  // 'off' = désactivée, 'keep' = ordre du site inchangé. MOVIX_SWIFTFLUX=…
  swiftfluxSource: 'last',
});

function readOnOffOverride(argv, env, flag, envName) {
  for (const arg of argv) {
    if (arg.startsWith(`--${flag}=`)) {
      const parsed = parseOnOff(arg.slice(flag.length + 3));
      if (parsed !== null) return parsed;
    }
  }
  if (env[envName] != null) {
    const parsed = parseOnOff(env[envName]);
    if (parsed !== null) return parsed;
  }
  return null;
}

function parseOnOff(value) {
  const normalized = String(value == null ? '' : value).trim().toLowerCase();
  if (['1', 'on', 'true', 'yes', 'oui'].includes(normalized)) return true;
  if (['0', 'off', 'false', 'no', 'non'].includes(normalized)) return false;
  return null;
}

/** `--site-branding=on|off` / MOVIX_SITE_BRANDING : true = marque du site visible. */
function readSiteBrandingOverride(argv, env) {
  for (const arg of argv) {
    if (arg.startsWith('--site-branding=')) {
      const parsed = parseOnOff(arg.slice('--site-branding='.length));
      if (parsed !== null) return parsed;
    }
  }
  if (env.MOVIX_SITE_BRANDING != null) {
    const parsed = parseOnOff(env.MOVIX_SITE_BRANDING);
    if (parsed !== null) return parsed;
  }
  return null;
}

function readAdBlockOverride(argv, env) {
  for (const arg of argv) {
    if (arg.startsWith('--adblock=')) {
      const parsed = parseOnOff(arg.slice('--adblock='.length));
      if (parsed !== null) return parsed;
    }
  }
  if (env.MOVIX_ADBLOCK != null) {
    const parsed = parseOnOff(env.MOVIX_ADBLOCK);
    if (parsed !== null) return parsed;
  }
  return null;
}

function normalizeSiteUrl(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return trimmed;
  } catch {
    return '';
  }
}

function readSiteOverride(argv, env) {
  for (const arg of argv) {
    if (arg.startsWith('--site=')) {
      const url = normalizeSiteUrl(arg.slice('--site='.length));
      if (url) return url;
    }
  }
  const fromEnv = normalizeSiteUrl(env.MOVIX_SITE_URL);
  return fromEnv || '';
}

class AppConfig {
  constructor(userDataDir, { argv = [], env = {} } = {}) {
    this.filePath = path.join(userDataDir, 'config.json');
    this.argv = argv;
    this.env = env;
    this.values = { ...DEFAULTS, ...this._read() };
    this.values.siteUrl = normalizeSiteUrl(this.values.siteUrl);
    this.siteOverride = readSiteOverride(argv, env);
    this.adBlockOverride = readAdBlockOverride(argv, env);
    this.siteBrandingOverride = readSiteBrandingOverride(argv, env);
    this.secureDnsOverride = readOnOffOverride(argv, env, 'secure-dns', 'MOVIX_SECURE_DNS');
    this.localVipOverride = readOnOffOverride(argv, env, 'local-vip', 'MOVIX_LOCAL_VIP');
  }

  /** Traitement de la source SwiftFlux : 'last' | 'off' | 'keep'. */
  get swiftfluxSource() {
    const candidates = [
      ...this.argv.filter((a) => a.startsWith('--swiftflux=')).map((a) => a.slice('--swiftflux='.length)),
      this.env.MOVIX_SWIFTFLUX,
      this.values.swiftfluxSource,
    ];
    for (const value of candidates) {
      const normalized = String(value == null ? '' : value).trim().toLowerCase();
      if (['last', 'off', 'keep'].includes(normalized)) return normalized;
    }
    return 'last';
  }

  /** Statut VIP local effectif (CLI/env > config.json). */
  get localVipEnabled() {
    if (this.localVipOverride !== null) return this.localVipOverride;
    return this.values.localVip !== false;
  }

  /** DNS sécurisé effectif (CLI/env > config.json). */
  get secureDnsEnabled() {
    if (this.secureDnsOverride !== null) return this.secureDnsOverride;
    return this.values.secureDns !== false;
  }

  /** Masquage de la marque du site effectif (CLI/env > config.json). */
  get hideSiteBranding() {
    if (this.siteBrandingOverride !== null) return !this.siteBrandingOverride;
    return this.values.hideSiteBranding !== false;
  }

  /** Blocage des pubs effectif (CLI/env > config.json). */
  get adBlockEnabled() {
    if (this.adBlockOverride !== null) return this.adBlockOverride;
    return this.values.adBlock !== false;
  }

  _read() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  get(key) {
    return this.values[key];
  }

  set(key, value) {
    this.values[key] = value;
    this.save();
  }

  /** URL de site imposée (CLI/env > config.json), ou '' pour l'auto. */
  get forcedSiteUrl() {
    return this.siteOverride || this.values.siteUrl || '';
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.values, null, 2), 'utf8');
    } catch {
      // une config non sauvée n'empêche pas l'app de tourner
    }
  }
}

module.exports = {
  AppConfig,
  DEFAULTS,
  normalizeSiteUrl,
  readAdBlockOverride,
  readSiteBrandingOverride,
  readSiteOverride,
};
