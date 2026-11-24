'use strict';

/**
 * Drapeaux du monde pour la photo de profil MEWFLIX (paquet flag-icons, MIT,
 * version carrée 1x1 qui tient dans une pastille ronde). Lus sur le disque à
 * la demande puis gardés en mémoire ; aucune requête réseau.
 */

const fs = require('fs');
const path = require('path');

// Nations du Royaume-Uni : absentes des codes pays à deux lettres.
const EXTRA_CODES = ['gb-eng', 'gb-sct', 'gb-wls', 'gb-nir'];
const CODE_PATTERN = /^(?:[a-z]{2}|gb-(?:eng|sct|wls|nir))$/;
// « xx » : drapeau générique « inconnu » du paquet, pas un pays.
const EXCLUDED = new Set(['xx']);

let cache = null;

function flagsDir() {
  return path.join(path.dirname(require.resolve('flag-icons/package.json')), 'flags', '1x1');
}

/** Code de drapeau valide (deux lettres ou nation du Royaume-Uni) ? */
function isFlagCode(code) {
  return typeof code === 'string' && CODE_PATTERN.test(code) && !EXCLUDED.has(code);
}

/** @returns {{code: string, svg: string}[]} tous les drapeaux, triés par code */
function listFlags() {
  if (cache) return cache;
  const dir = flagsDir();
  const codes = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.svg'))
    .map((name) => name.slice(0, -4))
    .filter((code) => isFlagCode(code) && (code.length === 2 || EXTRA_CODES.includes(code)))
    .sort();
  cache = codes.map((code) => ({ code, svg: fs.readFileSync(path.join(dir, `${code}.svg`), 'utf8') }));
  return cache;
}

/** @returns {string} SVG du drapeau, '' si le code est inconnu */
function flagSvg(code) {
  if (!isFlagCode(code)) return '';
  const found = listFlags().find((flag) => flag.code === code);
  return found ? found.svg : '';
}

module.exports = { listFlags, flagSvg, isFlagCode };
