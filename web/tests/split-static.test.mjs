import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRedirects, splitForStaticHosts } from '../scripts/split-static.mjs';

const CDN = 'https://cdn.example.workers.dev';

test('les redirections envoient API, vidéo et fichiers lourds vers le CDN, puis l\'appli monopage', () => {
  const files = ['index.html', 'sw.js', 'assets/index-abc.js', 'avatars/a/1.png', 'thumbnail.png', 'help/changer de lecteur.png'];
  const text = buildRedirects(files, `${CDN}/`, new Set(['index.html', 'sw.js']));
  const lines = text.split('\n').filter((l) => l && !l.startsWith('#'));
  assert.ok(lines.includes(`/api/*  ${CDN}/api/:splat  307`));
  assert.ok(lines.includes(`/media/*  ${CDN}/media/:splat  307`));
  assert.ok(lines.includes(`/assets/*  ${CDN}/assets/:splat  301`));
  assert.ok(lines.includes(`/thumbnail.png  ${CDN}/thumbnail.png  301`));
  assert.ok(lines.includes(`/help/changer%20de%20lecteur.png  ${CDN}/help/changer%20de%20lecteur.png  301`));
  assert.ok(!lines.some((l) => l.startsWith('/index.html') || l.startsWith('/sw.js')));
  assert.equal(lines[lines.length - 1], '/*  /index.html  200');
});

test('le site ne garde que les fichiers légers, le CDN reçoit le reste sans les règles d\'un autre hébergeur', () => {
  const root = mkdtempSync(join(tmpdir(), 'mewflix-split-'));
  const dist = join(root, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<head><link rel="manifest" href="/assets/manifest-x.json"></head>');
  writeFileSync(join(dist, 'sw.js'), '');
  writeFileSync(join(dist, '_redirects'), '/* /__shell.html 200');
  writeFileSync(join(dist, 'assets', 'manifest-x.json'), '{}');
  writeFileSync(join(dist, 'assets', 'index-abc.js'), '');
  writeFileSync(join(dist, 'thumbnail.png'), 'x');

  const siteDir = join(root, 'site');
  const cdnDir = join(root, 'cdn');
  const result = splitForStaticHosts({ dist, siteDir, cdnDir, cdnBase: CDN });

  assert.equal(result.siteFiles, 3);
  assert.ok(existsSync(join(siteDir, 'assets', 'manifest-x.json')));
  assert.ok(!existsSync(join(siteDir, 'assets', 'index-abc.js')));
  assert.ok(!existsSync(join(siteDir, 'thumbnail.png')));
  assert.match(readFileSync(join(siteDir, '_redirects'), 'utf8'), /\/thumbnail\.png {2}https:\/\/cdn\.example\.workers\.dev\/thumbnail\.png {2}301/);
  assert.ok(existsSync(join(cdnDir, 'assets', 'index-abc.js')));
  assert.ok(!existsSync(join(cdnDir, 'index.html')));
  assert.ok(!existsSync(join(cdnDir, '_redirects')));
  assert.match(readFileSync(join(cdnDir, '_headers'), 'utf8'), /Access-Control-Allow-Origin: \*/);
});

test('une adresse de CDN non https est refusée', () => {
  assert.throws(() => splitForStaticHosts({ dist: '.', siteDir: '.', cdnDir: '.', cdnBase: 'http://x' }), /CDN invalide/);
});
