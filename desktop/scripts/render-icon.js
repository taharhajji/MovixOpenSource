'use strict';

/**
 * Génère build/icon.png (1024×1024) à partir d'un SVG dessiné ici, en le
 * rendant hors écran avec Electron — aucun outil graphique externe requis.
 * electron-builder dérive ensuite l'.ico de l'installeur.
 *
 * Usage : npm run icon   (= electron scripts/render-icon.js)
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const BRAND = require('../src/branding');

const SIZE = 1024;
const OUT = path.join(__dirname, '..', 'build', 'icon.png');

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1b1b33"/>
      <stop offset="1" stop-color="${BRAND.BACKGROUND}"/>
    </linearGradient>
    <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${BRAND.ACCENT_SOFT}"/>
      <stop offset="1" stop-color="${BRAND.ACCENT}"/>
    </linearGradient>
    <radialGradient id="planet" cx="0.35" cy="0.3" r="0.8">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="0.35" stop-color="${BRAND.ACCENT_SOFT}"/>
      <stop offset="1" stop-color="#312e81"/>
    </radialGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="18" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="1024" height="1024" rx="224" fill="url(#bg)"/>
  <g transform="rotate(-28 512 512)">
    <ellipse cx="512" cy="512" rx="400" ry="150" fill="none" stroke="url(#ring)" stroke-width="54" stroke-linecap="round" stroke-dasharray="1800 520" filter="url(#glow)"/>
  </g>
  <circle cx="512" cy="512" r="190" fill="url(#planet)"/>
  <path d="M470 430 L600 512 L470 594 Z" fill="#0b0b1a" opacity="0.9"/>
  <circle cx="842" cy="330" r="34" fill="${BRAND.ACCENT_SOFT}" filter="url(#glow)"/>
</svg>`;

// Rendu en pixels physiques 1:1, quel que soit le facteur d'échelle Windows,
// et fenêtre autorisée à dépasser l'écran (sinon la capture est rognée).
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
    webPreferences: { offscreen: true },
  });
  win.setContentSize(SIZE, SIZE);
  win.webContents.setZoomFactor(1);
  const html = `<!doctype html><html><body style="margin:0;background:transparent;width:${SIZE}px;height:${SIZE}px;overflow:hidden">${svg}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, image.toPNG());
  const { width, height } = image.getSize();
  console.log(`[render-icon] ${OUT} (${width}×${height}, ${(fs.statSync(OUT).size / 1024).toFixed(0)} Ko)`);
  app.exit(width === SIZE && height === SIZE ? 0 : 1);
}).catch((err) => {
  console.error('[render-icon]', err);
  app.exit(1);
});
