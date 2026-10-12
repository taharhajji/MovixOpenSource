import test from 'node:test';
import assert from 'node:assert/strict';
import handler, { rewritePlaylist, relayUrlFor, hostAllowed } from '../api/media.js';

test('hostAllowed : suffixe exact ou sous-domaine, rien d’autre', () => {
  assert.equal(hostAllowed('finepulfe.xyz', ['finepulfe.xyz']), true);
  assert.equal(hostAllowed('free.finepulfe.xyz', ['finepulfe.xyz']), true);
  assert.equal(hostAllowed('notfinepulfe.xyz', ['finepulfe.xyz']), false);
  assert.equal(hostAllowed('example.com', ['finepulfe.xyz']), false);
});

test('rewritePlaylist : master, variantes relatives et absolues, attributs URI', () => {
  const base = 'https://free.finepulfe.xyz/movies/1-abc/master.m3u8';
  const input = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="fr",URI="audio/fr/index.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080',
    '1080/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000000',
    'https://cdn.finepulfe.xyz/movies/1-abc/480/index.m3u8',
    '',
  ].join('\n');
  const out = rewritePlaylist(input, base, '/media');
  const lines = out.split('\n');
  assert.equal(lines[0], '#EXTM3U');
  assert.equal(lines[1], `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="fr",URI="${relayUrlFor('https://free.finepulfe.xyz/movies/1-abc/audio/fr/index.m3u8', '/media')}"`);
  assert.equal(lines[2], '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080');
  assert.equal(lines[3], relayUrlFor('https://free.finepulfe.xyz/movies/1-abc/1080/index.m3u8', '/media'));
  assert.equal(lines[5], relayUrlFor('https://cdn.finepulfe.xyz/movies/1-abc/480/index.m3u8', '/media'));
  assert.equal(lines[6], '');
});

test('rewritePlaylist : segments, clé AES et map d’init', () => {
  const base = 'https://free.finepulfe.xyz/movies/1-abc/1080/index.m3u8';
  const input = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="/keys/1.key",IV=0x00',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:4.0,',
    'seg-0001.ts',
    '#EXT-X-ENDLIST',
  ].join('\n');
  const out = rewritePlaylist(input, base, '/media').split('\n');
  assert.equal(out[1], `#EXT-X-KEY:METHOD=AES-128,URI="${relayUrlFor('https://free.finepulfe.xyz/keys/1.key', '/media')}",IV=0x00`);
  assert.equal(out[2], `#EXT-X-MAP:URI="${relayUrlFor('https://free.finepulfe.xyz/movies/1-abc/1080/init.mp4', '/media')}"`);
  assert.equal(out[4], relayUrlFor('https://free.finepulfe.xyz/movies/1-abc/1080/seg-0001.ts', '/media'));
  assert.equal(out[5], '#EXT-X-ENDLIST');
});

test('handler : URL invalide → 400, hôte hors liste → 403, OPTIONS → 204 CORS', async () => {
  const bad = await handler(new Request('https://x.test/media?u=not-a-url'));
  assert.equal(bad.status, 400);
  const forbidden = await handler(new Request('https://x.test/media?u=' + encodeURIComponent('https://example.com/a.m3u8')));
  assert.equal(forbidden.status, 403);
  const preflight = await handler(new Request('https://x.test/media', { method: 'OPTIONS' }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
});

test('relayUrlFor : le nom de fichier reste en fin de chemin', () => {
  assert.equal(relayUrlFor('https://free.finepulfe.xyz/movies/1-abc/subs_fre.vtt', '/media'),
    '/media/subs_fre.vtt?u=' + encodeURIComponent('https://free.finepulfe.xyz/movies/1-abc/subs_fre.vtt'));
  assert.equal(relayUrlFor('https://free.finepulfe.xyz/', '/media'),
    '/media/media?u=' + encodeURIComponent('https://free.finepulfe.xyz/'));
});

test('publicOrigin : hôte transmis par Vercel, http en local', async () => {
  const { publicOrigin } = await import('../api/media.js');
  assert.equal(publicOrigin(new Request('https://internal.vercel.app/media', { headers: { 'x-forwarded-host': 'mewflix-app.vercel.app', 'x-forwarded-proto': 'https' } })), 'https://mewflix-app.vercel.app');
  assert.equal(publicOrigin(new Request('http://localhost:4312/media', { headers: { host: 'localhost:4312' } })), 'http://localhost:4312');
});
