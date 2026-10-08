#!/usr/bin/env node
/**
 * Construit la version web MEWFLIX (mobile et bureau, dans le navigateur) :
 * le front Movix du dépôt (src/, Vite) compilé avec l'API relayée par ce
 * déploiement, puis rebrandé et retouché après build.
 *
 *   node web/scripts/build.mjs --origin https://mewflix.vercel.app [--upstream https://api.movix.luxe]
 *
 * Résultat : web/dist/ (statique) + web/api/ (relais Edge) → `vercel deploy`.
 */

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(__dirname, '..');
const ROOT = resolve(WEB, '..');
const BRAND = require(join(ROOT, 'desktop', 'src', 'branding.js'));
const { buildSiteTweaks } = require(join(ROOT, 'desktop', 'src', 'injection', 'site-tweaks.js'));
const { SAFE_EXTERNAL_HOSTS } = require(join(ROOT, 'desktop', 'src', 'lib', 'navigationPolicy.js'));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// Origine vide (défaut) = build indépendant du domaine : le front appelle
// `/api/…` en relatif, donc le même dist sert n'importe quelle URL Vercel ou
// un domaine personnalisé. Les quatre points du code qui retombent sur
// `http://localhost:25565` quand la base est vide sont corrigés après build.
const ORIGIN = arg('origin', process.env.MEWFLIX_ORIGIN || '').replace(/\/+$/, '');
const UPSTREAM = arg('upstream', process.env.UPSTREAM_API || 'https://api.movix.luxe').replace(/\/+$/, '');
const SKIP_VITE = process.argv.includes('--skip-vite');
// URL publique (liens canoniques, JSON-LD, partages) : exigée par vite.config,
// indépendante de la base d'API qui reste relative.
const SITE_URL = arg('site', process.env.MEWFLIX_SITE_URL || ORIGIN || 'https://mewflix-app.vercel.app').replace(/\/+$/, '');

// Valeurs d'environnement du front : mêmes services que le site déployé, mais
// l'API passe par ce domaine (relais /api/*). WatchParty (Socket.IO) ne peut
// pas être relayé par Vercel : il vise l'API directement et restera bloqué par
// son CORS tant que ce domaine n'y est pas autorisé.
const env = {
  ...process.env,
  VITE_MAIN_API: ORIGIN,
  VITE_SITE_URL: SITE_URL,
  VITE_WATCHPARTY_API: UPSTREAM,
  VITE_PROXIES_EMBED_API: process.env.VITE_PROXIES_EMBED_API || UPSTREAM,
  // Clé TMDB du site public (présente telle quelle dans son bundle) : le front
  // interroge TMDB directement pour les catalogues. Surchargeable par l'env.
  VITE_TMDB_API_KEY: process.env.VITE_TMDB_API_KEY || 'f3d757824f08ea2cff45eb8f47ca3a1e',
  VITE_SUPPORT_TELEGRAM_URL: process.env.VITE_SUPPORT_TELEGRAM_URL || 'https://t.me/movix_site',
  VITE_TURNSTILE_SITE_KEY: process.env.VITE_TURNSTILE_SITE_KEY || '',
  VITE_TURNSTILE_INVISIBLE_SITEKEY: process.env.VITE_TURNSTILE_INVISIBLE_SITEKEY || '',
  VITE_ANALYTICS_PROVIDER: 'none',
  VITE_DEFAULT_MIRRORS: '',
  VITE_MIRRORS_CONFIG_URL: '',
  VITE_GLITCHTIP_DSN: '',
  VITE_AD_DIRECT_URLS_ADULT: '',
  VITE_AD_DIRECT_URL_SFW: '',
  VITE_AD_SCRIPT_SRC: '',
  VITE_SWIFTFLUX_AD_URL: '',
};

console.log(`[web] API ${ORIGIN || 'relative (indépendante du domaine)'} · site ${SITE_URL} · API relayée vers ${UPSTREAM}`);

if (!SKIP_VITE) {
  const res = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', 'build'], {
    cwd: ROOT, env, stdio: 'inherit', shell: process.platform === 'win32',
  });
  if (res.status !== 0) {
    console.error(`[web] vite build a échoué (code ${res.status})`);
    process.exit(res.status || 1);
  }
}

const SRC_DIST = join(ROOT, 'dist');
const DIST = join(WEB, 'dist');
if (!existsSync(join(SRC_DIST, 'index.html'))) {
  console.error(`[web] ${SRC_DIST}/index.html introuvable`);
  process.exit(1);
}
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
cpSync(SRC_DIST, DIST, { recursive: true });

// --- Base API relative : plus aucun repli vers localhost dans les bundles -------
if (!ORIGIN) {
  const assetsDir = join(DIST, 'assets');
  let patched = 0;
  for (const name of readdirSync(assetsDir)) {
    if (!name.endsWith('.js')) continue;
    const file = join(assetsDir, name);
    const before = readFileSync(file, 'utf8');
    if (!before.includes('http://localhost:25565')) continue;
    writeFileSync(file, before.split('http://localhost:25565').join(''));
    patched += 1;
  }
  console.log(`[web] replis localhost:25565 neutralisés dans ${patched} bundle(s)`);
}

// --- Icône et manifeste PWA ---------------------------------------------------
cpSync(join(ROOT, 'desktop', 'build', 'icon.png'), join(DIST, 'mewflix-icon.png'));
// Vite publie le manifeste sous un nom haché (assets/manifest-<hash>.json),
// référencé par <link rel="manifest"> dans index.html.
const manifestMatch = /<link rel="manifest" href="\/([^"]+)"/.exec(readFileSync(join(DIST, 'index.html'), 'utf8'));
const manifestPath = join(DIST, manifestMatch ? manifestMatch[1] : 'manifest.json');
if (existsSync(manifestPath)) {
  console.log(`[web] manifeste PWA : ${manifestMatch ? manifestMatch[1] : 'manifest.json'}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.name = BRAND.APP_NAME;
  manifest.short_name = BRAND.APP_NAME;
  manifest.description = BRAND.TAGLINE;
  manifest.background_color = BRAND.BACKGROUND;
  manifest.theme_color = BRAND.BACKGROUND;
  manifest.icons = [{ src: '/mewflix-icon.png', sizes: '1024x1024', type: 'image/png', purpose: 'any' }];
  for (const shortcut of manifest.shortcuts || []) {
    shortcut.icons = [{ src: '/mewflix-icon.png', sizes: '1024x1024' }];
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

// --- Service worker : désinscription (celui du site redirige vers des miroirs Movix)
cpSync(join(WEB, 'public', 'sw.js'), join(DIST, 'sw.js'));

// --- index.html : titre, métadonnées, icônes, retouches de site ----------------
const indexPath = join(DIST, 'index.html');
let html = readFileSync(indexPath, 'utf8');
const title = `${BRAND.APP_NAME} — Films et séries en streaming`;
html = html
  .replace(/<title>[\s\S]*?<\/title>/, `<title>${title}</title>`)
  .replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/, `$1${BRAND.APP_NAME}$2`)
  .replace(/(<meta name="application-name" content=")[^"]*(")/, `$1${BRAND.APP_NAME}$2`)
  .replace(/(<meta name="theme-color" content=")[^"]*(")/, `$1${BRAND.BACKGROUND}$2`)
  .replace(/(<meta name="msapplication-TileColor" content=")[^"]*(")/, `$1${BRAND.BACKGROUND}$2`)
  .replace(/(<meta\s+name="description"\s+content=")[^"]*(")/, `$1Regardez des milliers de films et séries en streaming HD sur ${BRAND.APP_NAME}. Catalogue complet en VF et VOSTFR.$2`)
  .replace(/href="\/movix\.png"/g, 'href="/mewflix-icon.png"')
  .replace(/<link rel="icon" type="image\/svg\+xml" href="[^"]*" \/>\s*/g, '')
  .replace(/"name": "Movix"/g, `"name": "${BRAND.APP_NAME}"`)
  .replace(/"alternateName": "Movix Streaming"/g, `"alternateName": "${BRAND.APP_NAME} Streaming"`)
  .replace(/Movix est une plateforme française open-source \(CC BY-NC 4\.0\) de streaming multimédia/g, `${BRAND.APP_NAME} est une plateforme de streaming multimédia`)
  .replace(/\/movix\.png"/g, '/mewflix-icon.png"')
  .replace(/"email": "[^"]*",?\s*/g, '')
  .replace(/"sameAs": \[[^\]]*\],?\s*/g, '');

const tweaks = buildSiteTweaks({
  appName: BRAND.APP_NAME,
  accent: BRAND.ACCENT,
  hideSiteBranding: true,
  localVip: true,
  adPopupAutoExpr: 'true',
  swiftfluxSource: 'last',
  storagePrefix: 'mewflix_web',
  popupSafeHosts: SAFE_EXTERNAL_HOSTS,
});
const tweaksTag = `<script id="mewflix-site-tweaks">${tweaks.replace(/<\/script/gi, '<\\/script')}</script>`;
if (!/<script id="mewflix-site-tweaks">/.test(html)) {
  html = html.replace(/<head>/i, `<head>\n        ${tweaksTag}`);
}
writeFileSync(indexPath, html);

// --- Résumé ----------------------------------------------------------------------
const leftovers = (html.match(/movix/gi) || []).length;
console.log(`[web] dist prêt : ${DIST}`);
console.log(`[web] index.html : titre « ${title} », retouches injectées, ${leftovers} mention(s) « movix » restantes (identifiants techniques)`);
