'use strict';

/**
 * Télécommande du mode TV : petit serveur HTTP sur le réseau local. Le
 * téléphone ouvre la page (QR code affiché sur la télé), chaque appui envoie
 * une commande JSON. Un jeton dans l'URL fait office de clé : sans lui, tout
 * est refusé. Seules des commandes d'une liste close sont acceptées.
 */

const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const KEYS = new Set([
  'up', 'down', 'left', 'right', 'ok', 'back', 'home', 'menu',
  'playpause', 'rewind', 'forward', 'volup', 'voldown', 'mute',
]);
const SCREENS = new Set(['home', 'movies', 'series', 'live', 'search', 'settings']);
const MAX_BODY = 2048;
const MAX_TEXT = 200;
const MAX_BAD_TOKENS = 20;
const LOCKOUT_MS = 60000;
const MAX_TRACKED_ADDRESSES = 500;
const HOST_PATTERN = /^(\d{1,3}\.){3}\d{1,3}(:\d{1,5})?$/;
const LOCALHOST_PATTERN = /^localhost(:\d{1,5})?$/;

/** Valide une commande reçue du téléphone. Retourne la commande nettoyée ou null. */
function parseCommand(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.type === 'key' && KEYS.has(raw.key)) return { type: 'key', key: raw.key };
  if (raw.type === 'nav' && SCREENS.has(raw.screen)) return { type: 'nav', screen: raw.screen };
  if (raw.type === 'text' && typeof raw.text === 'string') {
    // Caractères de contrôle retirés : le texte part dans un champ de recherche.
    const text = raw.text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_TEXT);
    return { type: 'text', text, submit: raw.submit === true };
  }
  return null;
}

// Partage de connexion de Windows (« Point d'accès sans fil mobile ») : le PC y
// porte toujours cette adresse. C'est le seul chemin sur un Wi-Fi de
// résidence, d'hôtel ou d'école, où les appareils sont isolés les uns des autres.
const WINDOWS_HOTSPOT_PREFIX = '192.168.137.';
// Cartes virtuelles (WSL, machines virtuelles, VPN) : jamais joignables par le téléphone.
const VIRTUAL_ADAPTER = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Docker|Loopback|Tailscale|ZeroTier|VPN/i;

/**
 * Adresses IPv4 de ce PC, de la plus probable à la moins probable pour un
 * téléphone : point d'accès Windows, réseau privé d'une vraie carte, puis le reste.
 */
function lanAddresses(interfaces = os.networkInterfaces()) {
  const isPrivate = (ip) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  const rank = (name, ip) => {
    if (ip.startsWith(WINDOWS_HOTSPOT_PREFIX)) return 0;
    const virtual = VIRTUAL_ADAPTER.test(name);
    if (isPrivate(ip)) return virtual ? 2 : 1;
    return virtual ? 4 : 3;
  };
  const found = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const item of list || []) {
      if (item && item.family === 'IPv4' && !item.internal) found.push({ address: item.address, rank: rank(name, item.address) });
    }
  }
  return found
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.address);
}

/** Adresse à donner au téléphone (voir lanAddresses), boucle locale faute de mieux. */
function lanAddress(interfaces = os.networkInterfaces()) {
  return lanAddresses(interfaces)[0] || '127.0.0.1';
}

/** Jeton de 64 bits : inatteignable par essais, encore recopiable à la main. */
function newToken() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Vrai pour la boucle locale et les adresses de ce PC. Le téléphone n'en fait
 * jamais partie ; une page ouverte sur ce PC (le site chargé par l'app, un
 * navigateur) si : elle ne doit pas pouvoir se faire passer pour lui.
 */
function isLocalAddress(address, interfaces = os.networkInterfaces()) {
  const clean = String(address || '').replace(/^::ffff:/, '');
  if (!clean || clean === '::1' || clean.startsWith('127.')) return true;
  for (const list of Object.values(interfaces)) {
    for (const item of list || []) {
      if (item && item.address === clean) return true;
    }
  }
  return false;
}

function sameToken(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/**
 * @param {object} options
 * @param {string} options.token
 * @param {string} options.pagePath        fichier HTML de la télécommande
 * @param {(cmd: object) => void} options.onCommand
 * @param {() => object} [options.getState]
 * @param {(req, res, url) => boolean} [options.extraRoute]  routes de diagnostic (dev)
 */
function createRemoteServer({
  token, pagePath, onCommand, getState = () => ({}), extraRoute = null, now = Date.now,
  // Développement et tests seulement : accepte les requêtes venant de ce PC.
  allowLocal = false,
  isLocal = isLocalAddress,
  addressOf = (req) => (req.socket && req.socket.remoteAddress) || '',
}) {
  const send = (res, status, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  // Anti-devinette : trop de mauvais jetons depuis une adresse, et elle est
  // refusée pendant une minute (le jeton est court pour rester tapable).
  const failures = new Map();
  const isLockedOut = (address) => {
    const entry = failures.get(address);
    if (!entry) return false;
    if (now() - entry.since > LOCKOUT_MS) {
      failures.delete(address);
      return false;
    }
    return entry.count >= MAX_BAD_TOKENS;
  };
  const recordFailure = (address) => {
    const entry = failures.get(address);
    if (entry && now() - entry.since <= LOCKOUT_MS) {
      failures.set(address, { since: entry.since, count: entry.count + 1 });
      return;
    }
    // Table pleine : on oublie la plus ancienne adresse, jamais toutes d'un coup
    // (sinon un flot d'adresses effacerait les blocages en cours).
    if (failures.size >= MAX_TRACKED_ADDRESSES) failures.delete(failures.keys().next().value);
    failures.set(address, { since: now(), count: 1 });
  };
  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://tv.local');
    } catch {
      return send(res, 400, { error: 'bad_request' });
    }
    const address = addressOf(req);
    if (!allowLocal && isLocal(address)) return send(res, 403, { error: 'local_forbidden' });
    // L'adresse tapée est toujours une IP : un nom de domaine signale une
    // attaque par réassociation DNS depuis une page web.
    const host = String(req.headers.host || '');
    if (!HOST_PATTERN.test(host) && !(allowLocal && LOCALHOST_PATTERN.test(host))) return send(res, 400, { error: 'bad_host' });
    // Une requête émise par la page d'un autre site porte son origine.
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) return send(res, 403, { error: 'cross_origin' });
    if (isLockedOut(address)) return send(res, 429, { error: 'too_many_attempts' });
    if (!sameToken(url.searchParams.get('t'), token)) {
      recordFailure(address);
      return send(res, 403, { error: 'forbidden' });
    }

    if (req.method === 'GET' && url.pathname === '/') {
      try {
        return send(res, 200, fs.readFileSync(pagePath), 'text/html; charset=utf-8');
      } catch {
        return send(res, 500, { error: 'page_missing' });
      }
    }
    if (req.method === 'GET' && url.pathname === '/state') return send(res, 200, { ok: true, ...getState() });
    if (extraRoute && extraRoute(req, res, url)) return undefined;
    if (req.method === 'POST' && url.pathname === '/cmd') {
      // JSON exigé : un formulaire ou un envoi « simple » d'une autre page ne passe pas.
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
        return send(res, 415, { error: 'json_required' });
      }
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          send(res, 413, { error: 'too_large' });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (res.writableEnded) return;
        let command = null;
        try {
          command = parseCommand(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          command = null;
        }
        if (!command) return send(res, 400, { error: 'bad_command' });
        try {
          onCommand(command);
        } catch (err) {
          return send(res, 500, { error: 'command_failed', detail: String(err && err.message) });
        }
        return send(res, 200, { ok: true });
      });
      return undefined;
    }
    return send(res, 404, { error: 'not_found' });
  });
  return server;
}

/** Écoute sur le port voulu, ou sur un port libre s'il est pris. */
function listen(server, port) {
  return new Promise((resolve, reject) => {
    const tryPort = (candidate, fallback) => {
      const onError = (err) => {
        if (fallback && err && err.code === 'EADDRINUSE') return tryPort(0, false);
        return reject(err);
      };
      server.once('error', onError);
      server.listen(candidate, '0.0.0.0', () => {
        server.removeListener('error', onError);
        resolve(server.address().port);
      });
    };
    tryPort(port, port !== 0);
  });
}

module.exports = { KEYS, SCREENS, createRemoteServer, isLocalAddress, lanAddress, lanAddresses, listen, newToken, parseCommand };
