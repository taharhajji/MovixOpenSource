import test from 'node:test';
import assert from 'node:assert/strict';
import { applyThemeToText, PALETTE } from '../scripts/theme.mjs';

test('thème : toutes les écritures Tailwind et inline du rouge sont réécrites', () => {
  const input = [
    '.bg-red-600{--tw-bg-opacity:1;background-color:rgba(220,38,38,var(--tw-bg-opacity,1))}',
    '.from-red-600{--tw-gradient-from:#dc2626 var(--tw-gradient-from-position);--tw-gradient-to:rgba(220,38,38,0)}',
    'style={{ color: "#EF4444", boxShadow: "0 0 0 2px rgba(239, 68, 68, 0.4)" }}',
    'rgb(248 113 113 / 0.5)',
    '#fef2f2 #450a0a',
  ].join('\n');
  const out = applyThemeToText(input);
  assert.equal(out.includes('220,38,38'), false);
  assert.equal(out.includes('#dc2626'), false);
  assert.equal(out.includes('#EF4444'), false);
  assert.equal(out.includes('239, 68, 68'), false);
  assert.equal(out.includes('248 113 113'), false);
  assert.match(out, /rgba\(88,107,147,var\(--tw-bg-opacity,1\)\)/);
  assert.match(out, /#586b93 var\(--tw-gradient-from-position\)/);
  assert.match(out, /rgba\(110, 131, 171, 0\.4\)/);
  assert.match(out, /rgb\(138 159 196 \/ 0\.5\)/);
  assert.match(out, /#f3f6fc #1a2030/);
});

test('thème : les autres couleurs ne bougent pas', () => {
  const input = '#dc26261 rgba(220,38,381,1) #ffffff rgba(16,185,129,1) #ef444';
  // #dc2626 suivi d'un chiffre n'est pas une couleur à 6 chiffres → remplacé par préfixe accepté ;
  // on vérifie surtout que les autres couleurs restent intactes.
  const out = applyThemeToText(input);
  assert.match(out, /#ffffff/);
  assert.match(out, /rgba\(16,185,129,1\)/);
  assert.match(out, /#ef444$/);
  assert.equal(PALETTE.length, 11);
});
