'use strict';

/**
 * Génère build/icon.png (1024×1024, coins transparents) — rendu hors écran
 * par Electron, aucun outil graphique externe requis. electron-builder en
 * dérive l'.ico de l'exe et de l'installeur.
 *
 * Source : build/logo-source.(png|jpg) si présent — le visuel fourni par la
 * team : le carré arrondi clair est détecté automatiquement (zone lumineuse
 * sur fond sombre), recadré, puis masqué en carré arrondi. Sinon, un logo SVG
 * de secours est dessiné.
 *
 * Usage : npm run icon   (= electron scripts/render-icon.js)
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const BRAND = require('../src/branding');

const SIZE = 1024;
const BUILD_DIR = path.join(__dirname, '..', 'build');
const OUT = path.join(BUILD_DIR, 'icon.png');
const SOURCE = ['logo-source.png', 'logo-source.jpg', 'logo-source.jpeg']
  .map((name) => path.join(BUILD_DIR, name))
  .find((file) => fs.existsSync(file));

const fallbackSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" rx="224" fill="${BRAND.BACKGROUND}"/>
  <text x="512" y="470" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-weight="900" font-size="210" fill="${BRAND.ACCENT}">MEW</text>
  <text x="512" y="700" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-weight="900" font-size="210" fill="${BRAND.ACCENT}">FLIX</text>
</svg>`;

// Exécuté dans la page hors écran : détecte le carré clair, recadre, masque,
// renvoie un PNG en data URL.
const CROP_SCRIPT = `
(async () => {
  const SIZE = ${SIZE};
  const img = document.querySelector('img');
  await img.decode();
  const w = img.naturalWidth, h = img.naturalHeight;
  const probe = document.createElement('canvas');
  probe.width = w; probe.height = h;
  const pctx = probe.getContext('2d', { willReadFrequently: true });
  pctx.drawImage(img, 0, 0);
  const data = pctx.getImageData(0, 0, w, h).data;
  // Zone « claire » : luminance élevée. Le halo autour du carré est plus
  // sombre que le carré lui-même : un seuil haut ne garde que le carré.
  const THRESHOLD = 150;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  const rows = new Int32Array(h), cols = new Int32Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      if (lum > THRESHOLD) { rows[y]++; cols[x]++; }
    }
  }
  // Bornes : lignes/colonnes où au moins 15 % des pixels sont clairs (évite
  // que quelques pixels de halo n'étirent le cadre).
  for (let y = 0; y < h; y++) if (rows[y] > w * 0.15) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  for (let x = 0; x < w; x++) if (cols[x] > h * 0.15) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
  if (maxX < 0 || maxY < 0) throw new Error('aucune zone claire détectée');
  // Carré centré sur la zone détectée, côté = la plus grande dimension.
  // Léger resserrement : le bord du carré porte un peu de halo/ombre.
  const detected = Math.max(maxX - minX, maxY - minY) + 1;
  const side = Math.round(detected * 0.97);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const sx = Math.max(0, Math.round(cx - side / 2)), sy = Math.max(0, Math.round(cy - side / 2));

  const out = document.createElement('canvas');
  out.width = SIZE; out.height = SIZE;
  const ctx = out.getContext('2d');
  // Masque carré arrondi (rayon ≈ 22 %, comme les icônes modernes).
  const r = SIZE * 0.22;
  ctx.beginPath();
  ctx.moveTo(r, 0); ctx.lineTo(SIZE - r, 0); ctx.quadraticCurveTo(SIZE, 0, SIZE, r);
  ctx.lineTo(SIZE, SIZE - r); ctx.quadraticCurveTo(SIZE, SIZE, SIZE - r, SIZE);
  ctx.lineTo(r, SIZE); ctx.quadraticCurveTo(0, SIZE, 0, SIZE - r);
  ctx.lineTo(0, r); ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
  ctx.clip();
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, side, side, 0, 0, SIZE, SIZE);
  return { dataUrl: out.toDataURL('image/png'), crop: { sx, sy, side, w, h } };
})()`;

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('high-dpi-support', '1');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: SIZE,
    height: SIZE,
    useContentSize: true,
    enableLargerThanScreen: true,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true, webSecurity: false },
  });
  win.setContentSize(SIZE, SIZE);

  let png;
  if (SOURCE) {
    const src = `file:///${SOURCE.replace(/\\/g, '/')}`;
    const html = `<!doctype html><html><body style="margin:0;background:transparent"><img src="${src}"></body></html>`;
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const { dataUrl, crop } = await win.webContents.executeJavaScript(CROP_SCRIPT, true);
    png = Buffer.from(dataUrl.split(',')[1], 'base64');
    console.log(`[render-icon] source ${path.basename(SOURCE)} ${crop.w}×${crop.h}, carré détecté ${crop.side}px à (${crop.sx}, ${crop.sy})`);
  } else {
    const html = `<!doctype html><html><body style="margin:0;background:transparent;width:${SIZE}px;height:${SIZE}px;overflow:hidden">${fallbackSvg}</body></html>`;
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    png = (await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE })).toPNG();
    console.log('[render-icon] aucune source build/logo-source.*, logo SVG de secours');
  }
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.writeFileSync(OUT, png);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  console.log(`[render-icon] ${OUT} (${width}×${height}, ${(png.length / 1024).toFixed(0)} Ko)`);
  app.exit(width === SIZE && height === SIZE ? 0 : 1);
}).catch((err) => {
  console.error('[render-icon]', err);
  app.exit(1);
});
