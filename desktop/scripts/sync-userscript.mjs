#!/usr/bin/env node
/**
 * Copie le userscript du dépôt (../userscript/movix.user.js) dans
 * resources/movix.user.js, sans son bloc ==UserScript== (inutile une fois
 * injecté par l'app), et note la version synchronisée.
 *
 * Lancé automatiquement avant `npm start` et `npm run build`.
 * Avec --check : vérifie seulement que la copie est à jour (CI).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(__dirname, '../../userscript/movix.user.js');
const outputDir = resolve(__dirname, '../resources');
const outputPath = resolve(outputDir, 'movix.user.js');
const metaPath = resolve(outputDir, 'userscript-meta.json');

if (!existsSync(sourcePath)) {
  console.error(`[sync-userscript] introuvable : ${sourcePath}`);
  process.exit(1);
}

const raw = readFileSync(sourcePath, 'utf8');
const versionMatch = /^\/\/ @version\s+(\S+)/m.exec(raw);
const version = versionMatch ? versionMatch[1] : 'inconnue';
const body = raw.replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/, '');
const output = `/* Movix userscript v${version} — copie générée par desktop/scripts/sync-userscript.mjs, ne pas éditer. */\n${body}`;
const meta = `${JSON.stringify({ version, bytes: Buffer.byteLength(output) }, null, 2)}\n`;

const current = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : null;

if (process.argv.includes('--check')) {
  if (current !== output) {
    console.error('[sync-userscript] resources/movix.user.js est périmé : lancez `npm run sync:userscript`');
    process.exit(1);
  }
  console.log(`[sync-userscript] à jour (v${version})`);
} else {
  mkdirSync(outputDir, { recursive: true });
  if (current !== output) writeFileSync(outputPath, output, 'utf8');
  writeFileSync(metaPath, meta, 'utf8');
  console.log(`[sync-userscript] v${version} → resources/movix.user.js (${(output.length / 1024).toFixed(1)} Ko)`);
}
