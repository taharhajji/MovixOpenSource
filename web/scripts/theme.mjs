/**
 * Thème MEWFLIX appliqué après build : la palette rouge de Tailwind (identité
 * Movix, ~1 500 utilisations dans les composants) est remplacée par une
 * gamme bleu ardoise tirée du logo (lettres #56637f sur fond glacé #dbe6f6).
 *
 * Tailwind 3 compile `bg-red-600` en `rgba(220,38,38,var(--tw-bg-opacity,1))`
 * et les dégradés en hexadécimal ; les composants React posent aussi des
 * couleurs en dur (`#ef4444`, `rgba(239, 68, 68, 0.4)`). Toutes ces formes
 * sont réécrites dans les CSS et les bundles JS du dist.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Gamme rouge Tailwind 3 → gamme MEWFLIX (même niveau de clarté, teinte ardoise).
export const PALETTE = [
  { level: 50,  from: '#fef2f2', to: '#f3f6fc' },
  { level: 100, from: '#fee2e2', to: '#e6edf8' },
  { level: 200, from: '#fecaca', to: '#cfdbef' },
  { level: 300, from: '#fca5a5', to: '#aebfdc' },
  { level: 400, from: '#f87171', to: '#8a9fc4' },
  { level: 500, from: '#ef4444', to: '#6e83ab' },
  { level: 600, from: '#dc2626', to: '#586b93' },
  { level: 700, from: '#b91c1c', to: '#475677' },
  { level: 800, from: '#991b1b', to: '#38445e' },
  { level: 900, from: '#7f1d1d', to: '#2a3348' },
  { level: 950, from: '#450a0a', to: '#1a2030' },
];

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Paires [regex, remplacement] couvrant toutes les écritures rencontrées. */
export function buildReplacements(palette = PALETTE) {
  const rules = [];
  for (const { from, to } of palette) {
    const [r, g, b] = hexToRgb(from);
    const [r2, g2, b2] = hexToRgb(to);
    // #dc2626 et #DC2626 (jamais suivi d'un autre chiffre hexa : #dc2626ff reste traité par le préfixe).
    rules.push([new RegExp(from, 'gi'), to]);
    // rgba(220,38,38,…) / rgb(220, 38, 38) / rgb(220 38 38 / …)
    // Les séparateurs d'origine (virgules, espaces) sont conservés tels quels.
    rules.push([new RegExp(`(rgba?\\(\\s*)${r}(\\s*,\\s*)${g}(\\s*,\\s*)${b}\\b`, 'g'), `$1${r2}$2${g2}$3${b2}`]);
    rules.push([new RegExp(`(rgba?\\(\\s*)${r}(\\s+)${g}(\\s+)${b}\\b`, 'g'), `$1${r2}$2${g2}$3${b2}`]);
  }
  return rules;
}

export function applyThemeToText(text, rules = buildReplacements()) {
  let out = text;
  for (const [re, rep] of rules) out = out.replace(re, rep);
  return out;
}

/**
 * Applique le thème à tous les CSS et JS de `distDir/assets` et à index.html.
 * @returns {{ files: number, replacements: number }}
 */
export function applyTheme(distDir) {
  const rules = buildReplacements();
  const assets = join(distDir, 'assets');
  let files = 0;
  let replacements = 0;
  const targets = readdirSync(assets).filter((n) => /\.(css|js)$/.test(n)).map((n) => join(assets, n));
  targets.push(join(distDir, 'index.html'));
  for (const file of targets) {
    const before = readFileSync(file, 'utf8');
    const after = applyThemeToText(before, rules);
    if (after !== before) {
      files += 1;
      replacements += countDiff(before, after, rules);
      writeFileSync(file, after);
    }
  }
  return { files, replacements };
}

function countDiff(before, _after, rules) {
  let n = 0;
  for (const [re] of rules) {
    const m = before.match(re);
    if (m) n += m.length;
  }
  return n;
}
