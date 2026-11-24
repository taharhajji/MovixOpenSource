'use strict';

/**
 * Mise à jour automatique sur macOS et Linux, où electron-updater ne peut pas
 * installer seul (app non signée par Apple, paquet .deb qui exige root).
 *
 *  1. lecture de la dernière release (API GitHub) et choix du fichier pour ce
 *     système et ce processeur ;
 *  2. téléchargement en arrière-plan, taille et empreinte SHA-256 vérifiées ;
 *  3. installation au redémarrage :
 *     - macOS : un petit script remplace MEWFLIX.app une fois l'app fermée,
 *       retire l'attribut de quarantaine et relance l'app (sauvegarde de
 *       l'ancienne version, restaurée si la copie échoue) ;
 *     - Linux : `sudo -n apt-get install` (Chromebook : sudo sans mot de
 *       passe), puis relance. Sans sudo possible, le paquet est ouvert dans
 *       l'installateur du système.
 *
 * Les fonctions pures (choix du fichier, empreinte, script) sont testées dans
 * tests/selfUpdate.test.mjs.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { execFile, spawn } = require('child_process');

const DOWNLOAD_HOST = /^https:\/\/github\.com\//;
const MAX_BYTES = 400 * 1024 * 1024;

/** Fichier de la release pour ce système, ou null. */
function pickAsset(assets, platform, arch) {
  let want = null;
  if (platform === 'darwin') want = arch === 'arm64' ? /-mac-arm64\.zip$/ : /-mac-x64\.zip$/;
  else if (platform === 'linux') want = arch === 'arm64' ? /-linux-arm64\.deb$/ : /-linux-amd64\.deb$/;
  if (!want || !Array.isArray(assets)) return null;
  return assets.find((a) => a && want.test(String(a.name || '')) && DOWNLOAD_HOST.test(String(a.browser_download_url || ''))) || null;
}

/** Empreinte attendue (champ `digest` de l'API GitHub : "sha256:<hex>"), '' si absente. */
function expectedSha256(asset) {
  const match = /^sha256:([0-9a-f]{64})$/i.exec(String((asset && asset.digest) || ''));
  return match ? match[1].toLowerCase() : '';
}

/** Chemin du paquet .app qui contient l'exécutable (macOS), '' sinon. */
function macBundleFromExe(exePath) {
  const marker = '.app/Contents/MacOS/';
  const at = String(exePath || '').indexOf(marker);
  return at < 0 ? '' : exePath.slice(0, at + 4);
}

/** macOS : app lancée depuis un emplacement isolé (téléchargements non déplacés) ? */
function isTranslocated(bundlePath) {
  return /\/AppTranslocation\//.test(String(bundlePath || '')) || /^\/Volumes\//.test(String(bundlePath || ''));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Script shell qui remplace l'app une fois le processus `pid` terminé.
 * L'ancienne version est gardée à côté jusqu'à ce que la copie réussisse.
 */
function macSwapScript({ pid, current, fresh, workDir }) {
  const cur = shellQuote(current);
  const neu = shellQuote(fresh);
  const old = shellQuote(`${current}.ancienne-version`);
  return [
    '#!/bin/sh',
    `i=0; while kill -0 ${Number(pid) | 0} 2>/dev/null && [ $i -lt 120 ]; do sleep 1; i=$((i+1)); done`,
    `rm -rf ${old}`,
    `if mv ${cur} ${old}; then`,
    `  if ditto ${neu} ${cur} 2>/dev/null || cp -R ${neu} ${cur}; then`,
    `    xattr -cr ${cur} 2>/dev/null; rm -rf ${old}`,
    '  else',
    `    rm -rf ${cur}; mv ${old} ${cur}`,
    '  fi',
    'fi',
    `rm -rf ${shellQuote(workDir)}`,
    `open ${cur}`,
    '',
  ].join('\n');
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: options.timeout || 120000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error ? error.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** Télécharge `url` dans `dest` en vérifiant taille et empreinte. */
async function download(fetchImpl, url, dest, { size = 0, sha256 = '' } = {}) {
  if (!DOWNLOAD_HOST.test(url)) throw new Error('adresse de téléchargement refusée');
  const res = await fetchImpl(url);
  if (!res.ok || !res.body) throw new Error(`téléchargement : HTTP ${res.status}`);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const source = Readable.fromWeb(res.body);
  source.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) source.destroy(new Error('fichier trop gros'));
    hash.update(chunk);
  });
  await pipeline(source, fs.createWriteStream(dest));
  if (size && bytes !== size) throw new Error(`taille inattendue (${bytes} au lieu de ${size})`);
  const digest = hash.digest('hex');
  if (sha256 && digest !== sha256) throw new Error('empreinte SHA-256 différente : fichier rejeté');
  return { bytes, sha256: digest };
}

/**
 * @param {{ app: Electron.App, fetchImpl: typeof fetch, releasesApi: string, isNewer: (a: string, b: string) => boolean,
 *   log?: (msg: string) => void, platform?: string, arch?: string }} deps
 */
function createSelfUpdater({ app, fetchImpl, releasesApi, isNewer, log = () => {}, platform = process.platform, arch = process.arch }) {
  let state = { status: 'idle', version: '', file: '', workDir: '', error: '' };
  let checking = null;

  async function latestRelease() {
    const res = await fetchImpl(releasesApi, { headers: { accept: 'application/vnd.github+json', 'user-agent': `MEWFLIX/${app.getVersion()}` } });
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    return res.json();
  }

  /** Vérifie et télécharge. Résout l'état : 'ready', 'none' ou 'unsupported'. */
  function check() {
    if (checking) return checking;
    checking = (async () => {
      if (state.status === 'ready') return state;
      const release = await latestRelease();
      const version = String(release.tag_name || '').replace(/^v/i, '');
      if (!version || !isNewer(version, app.getVersion())) { state = { ...state, status: 'none', version }; return state; }
      const asset = pickAsset(release.assets, platform, arch);
      if (!asset) { state = { ...state, status: 'unsupported', version }; return state; }
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mewflix-update-'));
      const file = path.join(workDir, path.basename(String(asset.name)));
      log(`téléchargement de ${asset.name}`);
      await download(fetchImpl, String(asset.browser_download_url), file, { size: Number(asset.size) || 0, sha256: expectedSha256(asset) });
      if (platform === 'darwin') {
        const unzip = await run('ditto', ['-x', '-k', file, path.join(workDir, 'app')]);
        if (!unzip.ok) throw new Error(`décompression : ${unzip.stderr || unzip.code}`);
      }
      state = { status: 'ready', version, file, workDir, error: '' };
      log(`${version} prête`);
      return state;
    })().catch((err) => {
      state = { ...state, status: 'error', error: err && err.message ? err.message : String(err) };
      log(`échec : ${state.error}`);
      return state;
    }).finally(() => { checking = null; });
    return checking;
  }

  /**
   * Installe la version téléchargée. Résout { ok, relaunch, reason } ;
   * `relaunch` : l'app doit se fermer (macOS, le script prend le relais) ou
   * redémarrer (Linux).
   */
  async function install() {
    if (state.status !== 'ready') return { ok: false, reason: 'rien à installer' };
    if (platform === 'darwin') {
      const current = macBundleFromExe(app.getPath('exe'));
      if (!current || isTranslocated(current)) return { ok: false, reason: 'translocated' };
      const appDir = path.join(state.workDir, 'app');
      const fresh = fs.readdirSync(appDir).find((name) => name.endsWith('.app'));
      if (!fresh) return { ok: false, reason: 'app introuvable dans le zip' };
      const script = path.join(state.workDir, 'installer.sh');
      fs.writeFileSync(script, macSwapScript({ pid: process.pid, current, fresh: path.join(appDir, fresh), workDir: state.workDir }), { mode: 0o755 });
      spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true, relaunch: 'quit' };
    }
    if (platform === 'linux') {
      const sudo = await run('sudo', ['-n', 'true'], { timeout: 10000 });
      if (!sudo.ok) return { ok: false, reason: 'no-sudo', file: state.file };
      const result = await run('sudo', ['-n', 'apt-get', 'install', '-y', state.file], { timeout: 300000 });
      if (!result.ok) return { ok: false, reason: `apt : ${(result.stderr || '').trim().split('\n').pop() || result.code}`, file: state.file };
      return { ok: true, relaunch: 'restart' };
    }
    return { ok: false, reason: 'système non pris en charge' };
  }

  return { check, install, get state() { return state; } };
}

module.exports = { pickAsset, expectedSha256, macBundleFromExe, isTranslocated, macSwapScript, shellQuote, download, createSelfUpdater };
