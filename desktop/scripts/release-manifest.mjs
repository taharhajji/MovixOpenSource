#!/usr/bin/env node
/**
 * Génère desktop/release/latest.yml, le manifeste lu par l'auto-updater.
 *
 * Pourquoi : le dépôt publie aussi des releases iOS (`ios-v*`). Le fournisseur
 * GitHub d'electron-updater ne regarde que la release « latest » du dépôt et
 * y chercherait latest.yml en vain. L'app lit donc un manifeste à URL stable
 * (raw.githubusercontent.com/…/desktop/release/latest.yml, même logique que
 * app/version.json pour l'APK), dont les fichiers pointent en absolu vers les
 * assets de la release GitHub `desktop-v<version>`.
 *
 * Usage : node scripts/release-manifest.mjs [--tag desktop-v1.2.3] [--repo owner/repo]
 *         (lit dist/latest.yml produit par electron-builder)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(desktopDir, 'package.json'), 'utf8'));

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const tag = arg('tag', `desktop-v${pkg.version}`);
const repo = arg('repo', 'movixstream/MovixOpenSource');
const inputPath = resolve(desktopDir, arg('input', 'dist/latest.yml'));
const outputPath = resolve(desktopDir, arg('output', 'release/latest.yml'));

if (!existsSync(inputPath)) {
  console.error(`[release-manifest] introuvable : ${inputPath} (lancez d'abord npm run build)`);
  process.exit(1);
}

const expectedVersion = tag.replace(/^desktop-v/, '');
if (expectedVersion !== pkg.version) {
  console.error(`[release-manifest] le tag ${tag} ne correspond pas à package.json (${pkg.version})`);
  process.exit(1);
}

const base = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/`;
const absolute = (file) => base + encodeURIComponent(file).replace(/%20/g, '-');

// latest.yml d'electron-builder : clés `url:` (dans files) et `path:` relatives.
const input = readFileSync(inputPath, 'utf8');
const output = input
  .replace(/^(\s*-\s*url:\s*)(\S+)\s*$/gm, (_m, prefix, file) => `${prefix}${absolute(file)}`)
  .replace(/^(path:\s*)(\S+)\s*$/gm, (_m, prefix, file) => `${prefix}${absolute(file)}`);

if (!/^version:\s*\S+/m.test(output)) {
  console.error('[release-manifest] dist/latest.yml ne ressemble pas à un manifeste electron-builder');
  process.exit(1);
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, output, 'utf8');
console.log(`[release-manifest] ${outputPath}\n${output}`);
