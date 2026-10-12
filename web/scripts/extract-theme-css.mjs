/**
 * Extrait du CSS compilé du site (web/dist, déjà passé au thème) les règles
 * qui portent une couleur de la gamme MEWFLIX, pour l'app de bureau : elle
 * charge le site en ligne (palette rouge Movix) et injecte ce sous-ensemble
 * en fin de <body>, après les feuilles du site, pour la même identité.
 *
 *   node web/scripts/extract-theme-css.mjs   → desktop/src/injection/theme.css
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PALETTE } from './theme.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, '..', 'dist');
const OUT = resolve(__dirname, '..', '..', 'desktop', 'src', 'injection', 'theme.css');

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const markers = PALETTE.flatMap(({ to }) => {
  const [r, g, b] = hexToRgb(to);
  return [to, `${r},${g},${b}`, `${r}, ${g}, ${b}`, `${r} ${g} ${b}`];
});
const hasThemeColor = (s) => markers.some((m) => s.includes(m));

/** Parse minimal : liste de { selector, body } et blocs @media imbriqués. */
export function extractThemedRules(css) {
  const out = [];
  let i = 0;
  const n = css.length;
  function readBlock() {
    // Appelé juste après '{' : renvoie le contenu jusqu'au '}' correspondant.
    let depth = 1;
    const start = i;
    while (i < n && depth > 0) {
      const ch = css[i++];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    return css.slice(start, i - 1);
  }
  function walk(prefix) {
    while (i < n) {
      const open = css.indexOf('{', i);
      if (open < 0) break;
      const selector = css.slice(i, open).trim();
      i = open + 1;
      const body = readBlock();
      if (!selector) continue;
      if (selector.startsWith('@media') || selector.startsWith('@supports') || selector.startsWith('@container')) {
        const saved = { i, n: css.length };
        // Parcours récursif du bloc
        const inner = extractThemedRules(body);
        if (inner) out.push(`${selector}{${inner}}`);
        i = saved.i;
        continue;
      }
      if (selector.startsWith('@')) continue; // @keyframes, @font-face…
      if (hasThemeColor(body)) out.push(`${prefix}${selector}{${body}}`);
    }
  }
  walk('');
  return out.join('');
}

const files = readdirSync(join(DIST, 'assets')).filter((f) => f.endsWith('.css'));
let total = '';
for (const file of files) total += extractThemedRules(readFileSync(join(DIST, 'assets', file), 'utf8'));
const header = '/* Généré par web/scripts/extract-theme-css.mjs — règles du site recolorées en gamme MEWFLIX. Ne pas éditer. */\n';
writeFileSync(OUT, header + total + '\n');
console.log(`[theme-css] ${files.length} feuille(s) → ${OUT} (${Math.round((header.length + total.length) / 1024)} Ko)`);
