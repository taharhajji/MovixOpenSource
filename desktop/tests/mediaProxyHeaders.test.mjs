import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyMediaProxyHeaderRules, hostnameOf, isProviderUrl } = require('../src/lib/mediaProxyHeaders.js');

test('hostnameOf lit l’hôte sans port, identifiants ni point final', () => {
  assert.equal(hostnameOf('https://user:pw@Lulustream.com.:443/x?y'), 'lulustream.com');
  assert.equal(hostnameOf('http://[::1]:8080/'), '[::1]');
  assert.equal(hostnameOf('pas une url'), null);
});

test('hôte inconnu : en-têtes inchangés', () => {
  const input = { Accept: '*/*', 'x-custom': '1' };
  const out = applyMediaProxyHeaderRules('https://example.com/video.m3u8', input);
  assert.deepEqual(out, input);
  assert.equal(isProviderUrl('https://example.com/video.m3u8'), false);
});

test('fsvid : Origin/Referer fs13 sur l’apex, Chrome desktop cohérent, encodage média', () => {
  const out = applyMediaProxyHeaderRules('https://fsvid.lol/hls/master.m3u8', { origin: 'https://movix.luxe' });
  assert.equal(out.Origin, 'https://fs13.lol');
  assert.equal(out.Referer, 'https://fs13.lol/');
  assert.equal(out.origin, undefined, 'l’en-tête en minuscules est remplacé, pas doublé');
  assert.match(out['User-Agent'], /Chrome\/140/);
  assert.equal(out['Sec-Ch-Ua-Platform'], '"Windows"');
  assert.match(out['Accept-Encoding'], /^identity/);
  assert.equal(isProviderUrl('https://s1.fsvid.lol/seg.ts'), true);
});

test('fsvid sous-domaine : Origin fsvid.lol, page HTML sans Accept-Encoding forcé', () => {
  const out = applyMediaProxyHeaderRules('https://s1.fsvid.lol/embed/abc', { 'Accept-Encoding': 'gzip' });
  assert.equal(out.Origin, 'https://fsvid.lol');
  assert.equal(out['Accept-Encoding'], undefined);
});

test('vidzy et uqload : origine du lecteur', () => {
  assert.equal(applyMediaProxyHeaderRules('https://cdn.vidzy.cc/a.mp4', {}).Referer, 'https://vidzy.org/');
  const uq = applyMediaProxyHeaderRules('https://m1.uqload.net/x.mp4', {});
  assert.equal(uq.Origin, 'https://uqload.net');
});

test('LuluStream (tnmr.org sous-domaine) : identité d’extraction, indices client relayés tels quels', () => {
  const out = applyMediaProxyHeaderRules('https://abc.tnmr.org/hls/v.m3u8', { 'sec-ch-ua': '"X";v="1"' });
  assert.equal(out.Origin, 'https://lulustream.com');
  assert.equal(out['User-Agent'], 'Mozilla/5.0 Chrome/143.0.0.0');
  assert.equal(out['Sec-Ch-Ua'], '"X";v="1"');
  assert.equal(out['Sec-Ch-Ua-Mobile'], undefined);
  assert.equal(out['Sec-Fetch-Mode'], 'cors');
});

test('apex tnmr.org : hors LuluStream', () => {
  assert.equal(isProviderUrl('https://tnmr.org/'), false);
});
