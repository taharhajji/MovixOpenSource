import test from 'node:test';
import assert from 'node:assert/strict';
import handler, {
  configureRelay, relayConfig, signUrl, verifySignature, signedRelayUrlFor, rewritePlaylistSigned, rewritePlaylist,
} from '../api/media.js';
import { rewriteStreamSources } from '../api/proxy.js';

const SECRET = 'test-secret-0123456789';

test('signature : stable, dépend du secret et de l’URL, vérification constante', async () => {
  const a = await signUrl('https://cdn.example/a.m3u8', SECRET);
  const b = await signUrl('https://cdn.example/a.m3u8', SECRET);
  const c = await signUrl('https://cdn.example/b.m3u8', SECRET);
  const d = await signUrl('https://cdn.example/a.m3u8', 'autre');
  assert.equal(a, b);
  assert.equal(a.length, 32);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
  assert.equal(await verifySignature('https://cdn.example/a.m3u8', a, SECRET), true);
  assert.equal(await verifySignature('https://cdn.example/a.m3u8', c, SECRET), false);
  assert.equal(await verifySignature('https://cdn.example/a.m3u8', a, ''), false);
  assert.equal(await signUrl('https://x', ''), '');
});

test('relais : hôte inconnu refusé sans signature, accepté avec une signature valide', async (t) => {
  configureRelay({ secret: SECRET, hosts: ['finepulfe.xyz'], base: '' });
  t.after(() => configureRelay({ secret: '', hosts: undefined, base: '' }));
  const target = 'https://autre-cdn.example/movies/1/master.m3u8';
  const refused = await handler(new Request(`https://x.test/media/master.m3u8?u=${encodeURIComponent(target)}`));
  assert.equal(refused.status, 403);
  const bad = await handler(new Request(`https://x.test/media/master.m3u8?u=${encodeURIComponent(target)}&s=deadbeef`));
  assert.equal(bad.status, 403);
  // Signature valide : le relais tente le fetch (502 ici, hôte inexistant) au lieu de refuser.
  const sig = await signUrl(target, SECRET);
  const accepted = await handler(new Request(`https://x.test/media/master.m3u8?u=${encodeURIComponent(target)}&s=${sig}`));
  assert.notEqual(accepted.status, 403);
});

test('relais externe : redirection 302 vers MEDIA_RELAY_BASE avec signature', async (t) => {
  configureRelay({ secret: SECRET, hosts: ['finepulfe.xyz'], base: 'https://relay.example' });
  t.after(() => configureRelay({ secret: '', hosts: undefined, base: '' }));
  const target = 'https://free.finepulfe.xyz/movies/1/master.m3u8';
  const res = await handler(new Request(`https://x.test/media/master.m3u8?u=${encodeURIComponent(target)}`, { headers: { host: 'x.test' } }));
  assert.equal(res.status, 302);
  const location = res.headers.get('location');
  assert.match(location, /^https:\/\/relay\.example\/media\/master\.m3u8\?u=/);
  assert.match(location, new RegExp(`&s=${await signUrl(target, SECRET)}$`));
});

test('playlist signée : chaque URI porte sa signature, le texte reste identique sinon', async () => {
  const base = 'https://cdn.example/movies/1/1080/index.m3u8';
  const input = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="/k.key"\n#EXTINF:4.0,\nseg-0.ts\n#EXT-X-ENDLIST';
  const out = await rewritePlaylistSigned(input, base, '/media', SECRET);
  const lines = out.split('\n');
  assert.equal(lines[0], '#EXTM3U');
  assert.equal(lines[1], `#EXT-X-KEY:METHOD=AES-128,URI="${await signedRelayUrlFor('https://cdn.example/k.key', '/media', SECRET)}"`);
  assert.equal(lines[3], await signedRelayUrlFor('https://cdn.example/movies/1/1080/seg-0.ts', '/media', SECRET));
  assert.equal(lines[4], '#EXT-X-ENDLIST');
  assert.equal(await rewritePlaylistSigned(input, base, '/media', ''), rewritePlaylist(input, base, '/media'));
});

test('sources de flux : URL réécrites vers le relais, signées avec secret, liste close sans', async () => {
  const payload = { purstream_id: 1, sources: [{ url: 'https://free.finepulfe.xyz/m/master.m3u8', name: 'pulse' }, { url: 'https://nouveau-cdn.example/m.m3u8', name: 'x' }, { url: 'pas une url' }] };
  const withSecret = JSON.parse(JSON.stringify(payload));
  await rewriteStreamSources(withSecret, 'https://site.test/media', { secret: SECRET, hosts: ['finepulfe.xyz'] });
  assert.match(withSecret.sources[0].url, /^https:\/\/site\.test\/media\/master\.m3u8\?u=.*&s=[0-9a-f]{32}$/);
  assert.match(withSecret.sources[1].url, /^https:\/\/site\.test\/media\/m\.m3u8\?u=.*&s=[0-9a-f]{32}$/);
  assert.equal(withSecret.sources[2].url, 'pas une url');

  const noSecret = JSON.parse(JSON.stringify(payload));
  await rewriteStreamSources(noSecret, 'https://site.test/media', { secret: '', hosts: ['finepulfe.xyz'] });
  assert.match(noSecret.sources[0].url, /^https:\/\/site\.test\/media\/master\.m3u8\?u=[^&]+$/);
  assert.equal(noSecret.sources[1].url, 'https://nouveau-cdn.example/m.m3u8');
});

test('en-têtes amont : encodés, signés avec l’URL, transmis seulement sur URL signée', async (t) => {
  const { encodeHeadersParam, decodeHeadersParam, signedPayload } = await import('../api/media.js');
  const { liveStreamHeaders } = await import('../api/proxy.js');
  const h = encodeHeadersParam({ 'User-Agent': 'VAVOO/2.6', Referer: 'https://r.example/', 'X-Evil': 'non' });
  assert.deepEqual(decodeHeadersParam(h), { 'user-agent': 'VAVOO/2.6', referer: 'https://r.example/' });
  assert.equal(encodeHeadersParam({}), '');
  assert.equal(decodeHeadersParam('@@@').constructor, Object);

  configureRelay({ secret: SECRET, hosts: ['finepulfe.xyz'], base: '' });
  t.after(() => configureRelay({ secret: '', hosts: undefined, base: '' }));
  const target = 'http://198.51.100.20:8008/sunshine/x/hls/index.m3u8';
  // Hôte de la liste close mais paramètre h sans signature : refusé.
  const unsigned = await handler(new Request(`https://x.test/media/index.m3u8?u=${encodeURIComponent('https://free.finepulfe.xyz/a.m3u8')}&h=${h}`));
  assert.equal(unsigned.status, 403);
  // Signature calculée sur u seul alors que h est présent : refusée.
  const wrongSig = await signUrl(target, SECRET);
  const mismatch = await handler(new Request(`https://x.test/media/index.m3u8?u=${encodeURIComponent(target)}&h=${h}&s=${wrongSig}`));
  assert.equal(mismatch.status, 403);
  // Signature sur u + h : acceptée (le fetch amont échoue ensuite, hôte fictif).
  const goodSig = await signUrl(signedPayload(target, h), SECRET);
  const accepted = await handler(new Request(`https://x.test/media/index.m3u8?u=${encodeURIComponent(target)}&h=${h}&s=${goodSig}`));
  assert.notEqual(accepted.status, 403);

  assert.deepEqual(liveStreamHeaders({ url: target, _directPlay: true }), { 'user-agent': 'VAVOO/2.6' });
  assert.deepEqual(liveStreamHeaders({ url: 'https://cdn.example/a.m3u8', referer: 'https://site.example/p' }), { referer: 'https://site.example/p', origin: 'https://site.example' });
  assert.deepEqual(liveStreamHeaders({ url: 'https://cdn.example/a.m3u8' }), {});
});

test('TV en direct : flux directs relayés avec en-têtes, lecteurs embed laissés intacts', async () => {
  const payload = { streams: [
    { title: 'Vavoo', url: 'http://198.51.100.20:8008/sunshine/x/hls/index.m3u8', _directPlay: true },
    { title: 'northlive', url: 'https://northlive.lol/api/v1/tv/x/player?api_key=k', _isEmbed: true },
  ] };
  const { liveStreamHeaders } = await import('../api/proxy.js');
  await rewriteStreamSources(payload, 'https://site.test/media', { secret: SECRET, hosts: ['finepulfe.xyz'] }, liveStreamHeaders);
  assert.match(payload.streams[0].url, /^https:\/\/site\.test\/media\/index\.m3u8\?u=.*&h=[A-Za-z0-9_-]+&s=[0-9a-f]{32}$/);
  assert.equal(payload.streams[0]._directPlay, true);
  assert.equal(payload.streams[1].url, 'https://northlive.lol/api/v1/tv/x/player?api_key=k');
});
