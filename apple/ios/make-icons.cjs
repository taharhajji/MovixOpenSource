'use strict';

/**
 * Génère le jeu d'icônes iOS (AppIcon.appiconset) de MEWFLIX à partir du
 * visuel desktop/build/logo-source.jpg, rendu hors écran par Electron.
 *
 * iOS exige des PNG opaques, carrés, sans coins arrondis (le système applique
 * son propre masque) : on recadre le carré clair du visuel sans masque.
 *
 * Usage (depuis desktop/, où Electron est installé) :
 *   node node_modules/electron/cli.js ../apple/ios/make-icons.cjs
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SOURCE = ['logo-source.png', 'logo-source.jpg', 'logo-source.jpeg']
  .map((name) => path.join(ROOT, 'desktop', 'build', name))
  .find((file) => fs.existsSync(file));
const OUT_DIR = path.join(__dirname, 'AppIcon.appiconset');
const TEMPLATE = path.join(ROOT, 'app', 'ios', 'Movix', 'Images.xcassets', 'AppIcon.appiconset', 'Contents.json');

// Tailles en pixels, fichier icon-<px>.png (mêmes noms que l'app mobile).
const SIZES = [20, 29, 40, 58, 60, 76, 80, 87, 120, 152, 167, 180, 1024];

const SCRIPT = `
(async () => {
  const img = document.querySelector('img');
  await img.decode();
  const w = img.naturalWidth, h = img.naturalHeight;
  const probe = document.createElement('canvas');
  probe.width = w; probe.height = h;
  const pctx = probe.getContext('2d', { willReadFrequently: true });
  pctx.drawImage(img, 0, 0);
  const data = pctx.getImageData(0, 0, w, h).data;
  const rows = new Int32Array(h), cols = new Int32Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2] > 150) { rows[y]++; cols[x]++; }
  }
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) if (rows[y] > w * 0.15) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  for (let x = 0; x < w; x++) if (cols[x] > h * 0.15) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
  if (maxX < 0) throw new Error('aucune zone claire détectée');
  const detected = Math.max(maxX - minX, maxY - minY) + 1;
  // Resserré de 6 % : iOS arrondit lui-même, le bord du carré source serait visible.
  const side = Math.round(detected * 0.94);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const sx = Math.round(cx - side / 2), sy = Math.round(cy - side / 2);
  const out = {};
  for (const size of ${JSON.stringify(SIZES)}) {
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#e4ebf5';
    ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
    out[size] = c.toDataURL('image/png').split(',')[1];
  }
  return out;
})()`;

app.commandLine.appendSwitch('force-device-scale-factor', '1');

// Garde-fou : jamais de processus Electron qui traîne si une étape se bloque.
setTimeout(() => {
  console.error('[make-icons] délai dépassé (60 s)');
  app.exit(2);
}, 60000).unref();

app.whenReady().then(async () => {
  if (!SOURCE) throw new Error('desktop/build/logo-source.(jpg|png) introuvable');
  console.log(`[make-icons] source ${SOURCE}`);
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1024,
    webPreferences: { offscreen: true, webSecurity: false },
  });
  win.webContents.on('console-message', (_e, _level, message) => console.log(`[page] ${message}`));
  const src = `file:///${SOURCE.replace(/\\/g, '/')}`;
  const html = `<!doctype html><html><body style="margin:0"><img src="${src}"></body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  console.log('[make-icons] page chargée, rendu des tailles…');
  const pngs = await win.webContents.executeJavaScript(SCRIPT, true);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const [size, base64] of Object.entries(pngs)) {
    fs.writeFileSync(path.join(OUT_DIR, `icon-${size}.png`), Buffer.from(base64, 'base64'));
  }
  if (fs.existsSync(TEMPLATE)) fs.copyFileSync(TEMPLATE, path.join(OUT_DIR, 'Contents.json'));
  console.log(`[make-icons] ${SIZES.length} icônes écrites dans ${OUT_DIR}`);
  app.exit(0);
}).catch((err) => {
  console.error('[make-icons]', err);
  app.exit(1);
});
