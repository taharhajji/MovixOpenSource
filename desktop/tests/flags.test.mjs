import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { listFlags, flagSvg, isFlagCode } = require('../src/lib/flags.js');

test('drapeaux du monde : tous les pays, nations du Royaume-Uni, pas le drapeau « inconnu »', () => {
  const codes = listFlags().map((flag) => flag.code);
  assert.ok(codes.length >= 250, `${codes.length} drapeaux`);
  for (const code of ['fr', 'ma', 'dz', 'tn', 'sn', 'us', 'jp', 'br', 'eu', 'gb-eng', 'gb-sct']) assert.ok(codes.includes(code), code);
  assert.ok(!codes.includes('xx'));
  assert.ok(listFlags().every((flag) => flag.svg.trimStart().startsWith('<svg')));
});

test('codes refusés : chemins, majuscules, inconnus', () => {
  assert.equal(flagSvg('../../package'), '');
  assert.equal(flagSvg('FR'), '');
  assert.equal(flagSvg('xx'), '');
  assert.equal(flagSvg(''), '');
  assert.ok(flagSvg('fr').includes('<svg'));
  assert.ok(isFlagCode('gb-wls'));
  assert.ok(!isFlagCode('gb-xyz'));
});
