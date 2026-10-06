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
});

function parseOnOff(value) {
  const normalized = String(value == null ? '' : value).trim().toLowerCase();
  if (['1', 'on', 'true', 'yes', 'oui'].includes(normalized)) return true;
  if (['0', 'off', 'false', 'no', 'non'].includes(normalized)) return false;
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
    this.values = { ...DEFAULTS, ...this._read() };
    this.values.siteUrl = normalizeSiteUrl(this.values.siteUrl);
    this.siteOverride = readSiteOverride(argv, env);
    this.adBlockOverride = readAdBlockOverride(argv, env);
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

module.exports = { AppConfig, DEFAULTS, normalizeSiteUrl, readAdBlockOverride, readSiteOverride };
