/**
 * Sépare web/dist en deux hébergements, pour tenir sur des offres gratuites :
 *
 *  - le **site** (Netlify) ne garde que la page d'accueil, le service worker,
 *    le manifeste PWA et une petite icône. Tout le reste y est redirigé ;
 *  - le **CDN** (Worker Cloudflare, fichiers statiques gratuits et illimités)
 *    reçoit les bundles JS/CSS, avatars, images, wasm…, et relaie /api et /media.
 *
 * Netlify facture la bande passante (crédits) : avec ce découpage, une visite y
 * coûte quelques Ko au lieu de plusieurs Mo, et aucune vidéo n'y passe.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Fichiers servis par le site lui-même (même origine obligatoire ou très légers).
const SITE_FILES = ['index.html', 'sw.js', 'offline.html', 'status.html', 'mewflix-icon-192.png', 'robots.txt'];
// Jamais copiés vers le CDN : propres au site, ou règles d'un autre hébergeur.
const CDN_EXCLUDED = new Set(['index.html', 'sw.js', '_redirects', '_headers', '_routes.json']);
// Dossiers redirigés d'un bloc (aucune route de l'appli ne commence par eux).
const WILDCARD_DIRS = ['assets', 'avatars', 'wasm'];

function listFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, base));
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

function manifestPathFrom(indexHtml) {
  const match = /<link rel="manifest" href="\/([^"]+)"/.exec(indexHtml);
  return match ? match[1] : null;
}

/** Chemin d'URL encodé, sans toucher aux « / ». */
function urlPath(file) {
  return `/${file.split('/').map(encodeURIComponent).join('/')}`;
}

export function buildRedirects(files, cdnBase, siteFiles) {
  const cdn = cdnBase.replace(/\/+$/, '');
  const lines = [
    '# Généré par web/scripts/split-static.mjs — ne pas modifier à la main.',
    '# API et vidéo : jamais servies par ce site (307 conserve la méthode et le corps).',
    `/api/*  ${cdn}/api/:splat  307`,
    `/media/*  ${cdn}/media/:splat  307`,
    `/media  ${cdn}/media  307`,
    '# Fichiers lourds : hébergés par le CDN (les fichiers présents ici restent servis ici).',
    ...WILDCARD_DIRS.map((dir) => `/${dir}/*  ${cdn}/${dir}/:splat  301`),
  ];
  for (const file of files) {
    if (siteFiles.has(file) || CDN_EXCLUDED.has(file)) continue;
    if (WILDCARD_DIRS.some((dir) => file.startsWith(`${dir}/`))) continue;
    lines.push(`${urlPath(file)}  ${cdn}${urlPath(file)}  301`);
  }
  lines.push('/status  /status.html  200', '# Application monopage : toute autre adresse affiche l\'appli.', '/*  /index.html  200', '');
  return lines.join('\n');
}

const SITE_HEADERS = `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
/index.html
  Cache-Control: no-cache
/sw.js
  Cache-Control: no-cache
/offline.html
  Cache-Control: no-cache
/status.html
  Cache-Control: no-cache
/assets/*
  Cache-Control: public, max-age=3600
`;

// Bundles chargés en <script type="module" crossorigin> depuis le site : CORS requis.
const CDN_HEADERS = `/*
  Access-Control-Allow-Origin: *
  X-Content-Type-Options: nosniff
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/avatars/*
  Cache-Control: public, max-age=604800
/live/*
  Cache-Control: public, max-age=604800
`;

/**
 * @param {{dist: string, siteDir: string, cdnDir: string, cdnBase: string}} options
 * @returns {{siteFiles: number, cdnFiles: number, redirects: number}}
 */
export function splitForStaticHosts({ dist, siteDir, cdnDir, cdnBase }) {
  if (!/^https:\/\//.test(cdnBase)) throw new Error(`adresse du CDN invalide : ${cdnBase}`);
  const indexHtml = readFileSync(join(dist, 'index.html'), 'utf8');
  const manifest = manifestPathFrom(indexHtml);
  const siteFiles = new Set([...SITE_FILES, ...(manifest ? [manifest] : [])].filter((f) => existsSync(join(dist, f))));
  const files = listFiles(dist);

  rmSync(siteDir, { recursive: true, force: true });
  mkdirSync(siteDir, { recursive: true });
  for (const file of siteFiles) {
    mkdirSync(join(siteDir, file, '..'), { recursive: true });
    cpSync(join(dist, file), join(siteDir, file));
  }
  const redirects = buildRedirects(files, cdnBase, siteFiles);
  writeFileSync(join(siteDir, '_redirects'), redirects);
  writeFileSync(join(siteDir, '_headers'), SITE_HEADERS);
  // Aucune étape de build chez Netlify : le dossier est publié tel quel.
  writeFileSync(join(siteDir, 'netlify.toml'), '[build]\n  publish = "."\n');

  rmSync(cdnDir, { recursive: true, force: true });
  mkdirSync(cdnDir, { recursive: true });
  let cdnFiles = 0;
  for (const file of files) {
    if (CDN_EXCLUDED.has(file)) continue;
    mkdirSync(join(cdnDir, file, '..'), { recursive: true });
    cpSync(join(dist, file), join(cdnDir, file));
    cdnFiles += 1;
  }
  writeFileSync(join(cdnDir, '_headers'), CDN_HEADERS);

  return { siteFiles: siteFiles.size, cdnFiles, redirects: redirects.split('\n').filter((l) => l && !l.startsWith('#')).length };
}
