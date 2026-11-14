import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const tvRemote = require('../src/lib/tvRemote.js');
const { pickNext, controlVideo } = require('../src/lib/tvNav.js');
const { AppConfig } = require('../src/lib/config.js');

const rect = (left, top, width = 100, height = 150) => ({ left, top, right: left + width, bottom: top + height });

async function withServer(options, run) {
  const dir = mkdtempSync(join(tmpdir(), 'mewflix-tv-'));
  const pagePath = join(dir, 'remote.html');
  writeFileSync(pagePath, '<!doctype html><title>remote</title>');
  const received = [];
  const server = tvRemote.createRemoteServer({
    token: 'a1b2c3d4',
    pagePath,
    onCommand: (command) => received.push(command),
    allowLocal: true,
    ...options,
  });
  const port = await tvRemote.listen(server, 0);
  const base = `http://127.0.0.1:${port}`;
  try {
    await run({ base, received });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
}

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

test('parseCommand : seules les touches, écrans et textes prévus passent', () => {
  assert.deepEqual(tvRemote.parseCommand({ type: 'key', key: 'up' }), { type: 'key', key: 'up' });
  assert.deepEqual(tvRemote.parseCommand({ type: 'nav', screen: 'live' }), { type: 'nav', screen: 'live' });
  assert.equal(tvRemote.parseCommand({ type: 'key', key: 'F12' }), null);
  assert.equal(tvRemote.parseCommand({ type: 'nav', screen: '../etc' }), null);
  assert.equal(tvRemote.parseCommand({ type: 'eval', code: 'alert(1)' }), null);
  assert.equal(tvRemote.parseCommand(null), null);
  assert.equal(tvRemote.parseCommand('up'), null);
});

test('parseCommand : texte borné et sans caractères de contrôle', () => {
  const parsed = tvRemote.parseCommand({ type: 'text', text: `dune\n\u0000${'x'.repeat(400)}`, submit: 'yes' });
  assert.equal(parsed.type, 'text');
  assert.equal(parsed.text.length, 200);
  assert.equal(parsed.text.startsWith('dune  x'), true);
  assert.equal(parsed.submit, false, 'submit doit être le booléen true');
  assert.equal(tvRemote.parseCommand({ type: 'text', text: 42 }), null);
});

test('lanAddress : adresse privée IPv4 de préférence, repli sur la boucle locale', () => {
  const interfaces = {
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    vpn: [{ family: 'IPv4', internal: false, address: '100.64.0.9' }],
    wifi: [{ family: 'IPv6', internal: false, address: 'fe80::1' }, { family: 'IPv4', internal: false, address: '192.168.1.42' }],
  };
  assert.equal(tvRemote.lanAddress(interfaces), '192.168.1.42');
  assert.equal(tvRemote.lanAddress({ lo: interfaces.lo }), '127.0.0.1');
  assert.equal(tvRemote.lanAddress({ vpn: interfaces.vpn }), '100.64.0.9');
});

test('lanAddress : point d’accès Windows d’abord, cartes virtuelles en dernier', () => {
  const ip = (address) => [{ family: 'IPv4', internal: false, address }];
  // Wi-Fi de résidence (appareils isolés) + partage de connexion du PC + WSL.
  const residence = {
    'vEthernet (WSL (Hyper-V firewall))': ip('172.20.80.1'),
    'Wi-Fi 2': ip('10.188.70.104'),
    'Connexion au réseau local* 10': ip('192.168.137.1'),
  };
  assert.equal(tvRemote.lanAddress(residence), '192.168.137.1', 'le téléphone est sur le point d’accès du PC');
  assert.deepEqual(tvRemote.lanAddresses(residence), ['192.168.137.1', '10.188.70.104', '172.20.80.1']);
  const home = { 'vEthernet (WSL)': ip('172.20.80.1'), 'Wi-Fi': ip('192.168.1.42') };
  assert.equal(tvRemote.lanAddress(home), '192.168.1.42', 'la carte WSL ne passe jamais devant le vrai Wi-Fi');
  assert.equal(tvRemote.lanAddress({ 'vEthernet (WSL)': ip('172.20.80.1') }), '172.20.80.1', 'faute de mieux');
  assert.deepEqual(tvRemote.lanAddresses({}), []);
});

test('newToken : seize caractères hexadécimaux, différents à chaque appel', () => {
  const a = tvRemote.newToken();
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, tvRemote.newToken());
});

test('serveur : sans le bon jeton, tout est refusé', async () => {
  await withServer({}, async ({ base, received }) => {
    assert.equal((await fetch(`${base}/`)).status, 403);
    assert.equal((await fetch(`${base}/?t=mauvais`)).status, 403);
    assert.equal((await post(`${base}/cmd?t=a1b2c3d`, '{"type":"key","key":"ok"}')).status, 403);
    assert.equal(received.length, 0);
  });
});

test('serveur : page, état et commandes avec le jeton', async () => {
  await withServer({ getState: () => ({ app: 'TEST' }) }, async ({ base, received }) => {
    const page = await fetch(`${base}/?t=a1b2c3d4`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /remote/);

    const state = await (await fetch(`${base}/state?t=a1b2c3d4`)).json();
    assert.deepEqual(state, { ok: true, app: 'TEST' });

    assert.equal((await post(`${base}/cmd?t=a1b2c3d4`, '{"type":"key","key":"left"}')).status, 200);
    assert.equal((await post(`${base}/cmd?t=a1b2c3d4`, '{"type":"text","text":"dune","submit":true}')).status, 200);
    assert.deepEqual(received, [{ type: 'key', key: 'left' }, { type: 'text', text: 'dune', submit: true }]);

    assert.equal((await post(`${base}/cmd?t=a1b2c3d4`, '{"type":"key","key":"nope"}')).status, 400);
    assert.equal((await post(`${base}/cmd?t=a1b2c3d4`, 'pas du json')).status, 400);
    assert.equal((await post(`${base}/cmd?t=a1b2c3d4`, JSON.stringify({ type: 'text', text: 'x'.repeat(5000) }))).status, 413);
    assert.equal((await fetch(`${base}/inconnu?t=a1b2c3d4`)).status, 404);
    assert.equal(received.length, 2);
  });
});

test('serveur : une commande qui échoue répond 500 sans tomber', async () => {
  await withServer({ onCommand: () => { throw new Error('fenêtre fermée'); } }, async ({ base }) => {
    const res = await post(`${base}/cmd?t=a1b2c3d4`, '{"type":"key","key":"ok"}');
    assert.equal(res.status, 500);
    assert.equal((await fetch(`${base}/state?t=a1b2c3d4`)).status, 200);
  });
});

test('serveur : trop de mauvais jetons bloquent l’adresse une minute', async () => {
  let clock = 1000;
  await withServer({ now: () => clock }, async ({ base }) => {
    for (let i = 0; i < 20; i += 1) assert.equal((await fetch(`${base}/?t=essai${i}`)).status, 403);
    assert.equal((await fetch(`${base}/?t=a1b2c3d4`)).status, 429, 'même le bon jeton attend la fin du blocage');
    clock += 61000;
    assert.equal((await fetch(`${base}/?t=a1b2c3d4`)).status, 200);
  });
});

test('isLocalAddress : boucle locale et adresses de ce PC, pas celles du réseau', () => {
  const interfaces = { wifi: [{ family: 'IPv4', internal: false, address: '192.168.1.42' }] };
  assert.equal(tvRemote.isLocalAddress('127.0.0.1', interfaces), true);
  assert.equal(tvRemote.isLocalAddress('::1', interfaces), true);
  assert.equal(tvRemote.isLocalAddress('::ffff:127.0.0.1', interfaces), true);
  assert.equal(tvRemote.isLocalAddress('::ffff:192.168.1.42', interfaces), true, 'le PC lui-même par son adresse réseau');
  assert.equal(tvRemote.isLocalAddress('192.168.1.50', interfaces), false, 'le téléphone');
  assert.equal(tvRemote.isLocalAddress('', interfaces), true, 'adresse inconnue : refusée par prudence');
});

test('serveur : une requête venant de ce PC est refusée hors développement', async () => {
  await withServer({ allowLocal: false }, async ({ base, received }) => {
    assert.equal((await fetch(`${base}/?t=a1b2c3d4`)).status, 403);
    assert.equal((await post(`${base}/cmd?t=a1b2c3d4`, '{"type":"key","key":"ok"}')).status, 403);
    assert.equal(received.length, 0);
  });
  await withServer({ allowLocal: false, isLocal: () => false }, async ({ base, received }) => {
    assert.equal((await post(`${base}/cmd?t=a1b2c3d4`, '{"type":"key","key":"ok"}')).status, 200, 'le téléphone passe');
    assert.equal(received.length, 1);
  });
});

test('serveur : autre origine, nom de domaine ou envoi non JSON refusés', async () => {
  await withServer({}, async ({ base, received }) => {
    const port = new URL(base).port;
    const cross = await fetch(`${base}/cmd?t=a1b2c3d4`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://site.example' }, body: '{"type":"key","key":"ok"}',
    });
    assert.equal(cross.status, 403, 'page d’un autre site');
    const same = await fetch(`${base}/cmd?t=a1b2c3d4`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` }, body: '{"type":"key","key":"ok"}',
    });
    assert.equal(same.status, 200, 'la page de la télécommande elle-même');
    const form = await fetch(`${base}/cmd?t=a1b2c3d4`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"type":"key","key":"ok"}' });
    assert.equal(form.status, 415);
    const rebound = await new Promise((resolve, reject) => {
      const req = require('node:http').request({ host: '127.0.0.1', port, path: '/state?t=a1b2c3d4', headers: { host: `tv.attaquant.example:${port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(rebound, 400, 'réassociation DNS');
    assert.equal(received.length, 1);
  });
});

test('serveur : la table des échecs oublie la plus ancienne adresse, pas toutes', async () => {
  let from = 'attaquant';
  await withServer({ addressOf: () => from, isLocal: () => false, allowLocal: false }, async ({ base }) => {
    for (let i = 0; i < 20; i += 1) assert.equal((await fetch(`${base}/?t=faux`)).status, 403);
    assert.equal((await fetch(`${base}/?t=a1b2c3d4`)).status, 429, 'attaquant bloqué');
    // 499 autres adresses se trompent une fois : la table (500 entrées) est pleine.
    for (let i = 0; i < 499; i += 1) {
      from = `autre-${i}`;
      await fetch(`${base}/?t=faux`);
    }
    from = 'attaquant';
    assert.equal((await fetch(`${base}/?t=a1b2c3d4`)).status, 429, 'toujours bloqué quand la table est pleine');
    // Une adresse de plus : seule la plus ancienne entrée (l'attaquant) sort de la table.
    from = 'derniere';
    await fetch(`${base}/?t=faux`);
    from = 'autre-0';
    assert.equal((await fetch(`${base}/?t=a1b2c3d4`)).status, 200, 'les autres adresses gardent leur état');
  });
});

test('contrat : la page du téléphone et l’interface TV connaissent les mêmes touches et écrans', () => {
  const page = readFileSync(new URL('../src/pages/remote.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/injection/tv-app.js', import.meta.url), 'utf8');
  const keys = [...page.matchAll(/data-key="([a-z]+)"/g)].map((m) => m[1]);
  const screens = [...page.matchAll(/data-nav="([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length >= 10 && screens.length === 6);
  for (const key of keys) assert.equal(tvRemote.KEYS.has(key), true, `touche inconnue du serveur : ${key}`);
  for (const screen of screens) {
    assert.equal(tvRemote.SCREENS.has(screen), true, `écran inconnu du serveur : ${screen}`);
    assert.ok(new RegExp(`\n    ${screen}: function`).test(app), `écran absent de l'interface : ${screen}`);
  }
});

test('serveur : les routes supplémentaires restent derrière le jeton', async () => {
  const extraRoute = (req, res, url) => {
    if (url.pathname !== '/shot') return false;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('capture');
    return true;
  };
  await withServer({ extraRoute }, async ({ base }) => {
    assert.equal((await fetch(`${base}/shot`)).status, 403);
    assert.equal(await (await fetch(`${base}/shot?t=a1b2c3d4`)).text(), 'capture');
  });
});

test('listen : port occupé = repli sur un port libre', async () => {
  const first = tvRemote.createRemoteServer({ token: 'a1b2c3d4', pagePath: 'x', onCommand() {} });
  const second = tvRemote.createRemoteServer({ token: 'a1b2c3d4', pagePath: 'x', onCommand() {} });
  const port = await tvRemote.listen(first, 0);
  const other = await tvRemote.listen(second, port);
  assert.notEqual(other, port);
  await new Promise((resolve) => first.close(resolve));
  await new Promise((resolve) => second.close(resolve));
});

test('pickNext : reste dans la rangée à gauche/droite', () => {
  const row = [rect(0, 0), rect(120, 0), rect(240, 0)];
  const below = [rect(0, 200), rect(120, 200)];
  const all = [...row, ...below];
  assert.equal(pickNext(all[0], all.slice(1), 'right'), 0, 'voisin immédiat de droite');
  assert.equal(pickNext(all[1], [all[0], all[2], all[3], all[4]], 'left'), 0);
  assert.equal(pickNext(all[2], [all[0], all[1], all[3], all[4]], 'right'), -1, 'rien à droite du dernier');
});

test('pickNext : reste dans la colonne en haut/bas', () => {
  const current = rect(120, 0);
  const candidates = [rect(0, 200), rect(120, 200), rect(240, 200), rect(120, 400)];
  assert.equal(pickNext(current, candidates, 'down'), 1, 'carte juste en dessous, pas la plus à gauche');
  assert.equal(pickNext(candidates[3], [current, candidates[1]], 'up'), 1, 'la plus proche vers le haut');
  assert.equal(pickNext(current, candidates, 'up'), -1);
});

test('pickNext : élément décalé accepté faute de mieux, cas limites', () => {
  const rail = rect(0, 300, 60, 60);
  const card = rect(200, 0);
  assert.equal(pickNext(card, [rail], 'left'), 0, 'du contenu vers le menu latéral');
  assert.equal(pickNext(null, [rail, card], 'down'), 0, 'sans curseur : premier élément');
  assert.equal(pickNext(card, [], 'down'), -1);
  assert.equal(pickNext(card, null, 'down'), -1);
});

function fakeVideo(overrides = {}) {
  const video = {
    readyState: 4, videoWidth: 1920, videoHeight: 1080, paused: false, muted: false,
    volume: 0.5, currentTime: 100, duration: 600,
    pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
    ...overrides,
  };
  return video;
}
const docWith = (...videos) => ({ querySelectorAll: () => videos });

test('controlVideo : lecture, pause, avance, recul', () => {
  const video = fakeVideo();
  const doc = docWith(video);
  assert.equal(controlVideo(doc, 'ok'), '⏸ Pause');
  assert.equal(video.paused, true);
  assert.equal(controlVideo(doc, 'playpause'), '▶ Lecture');
  assert.equal(video.paused, false);
  assert.equal(controlVideo(doc, 'right'), '+10 s');
  assert.equal(video.currentTime, 110);
  assert.equal(controlVideo(doc, 'rewind'), '−30 s');
  assert.equal(video.currentTime, 80);
  video.currentTime = 595;
  controlVideo(doc, 'forward');
  assert.equal(video.currentTime, 599, 'ne dépasse pas la fin');
  video.currentTime = 4;
  controlVideo(doc, 'left');
  assert.equal(video.currentTime, 0, 'ne passe pas sous zéro');
});

test('controlVideo : une vidéo muette retrouve le son avant de pouvoir être mise en pause', () => {
  const live = fakeVideo({ muted: true });
  const doc = docWith(live);
  assert.equal(controlVideo(doc, 'ok'), '🔊 Son activé');
  assert.equal(live.muted, false);
  assert.equal(live.paused, false, 'la lecture continue');
  assert.equal(controlVideo(doc, 'ok'), '⏸ Pause');
  const stopped = fakeVideo({ muted: true, paused: true });
  assert.equal(controlVideo(docWith(stopped), 'playpause'), '▶ Lecture');
  assert.equal(stopped.muted, false, 'relancer une vidéo muette rend aussi le son');
});

test('controlVideo : volume borné, coupure du son', () => {
  const video = fakeVideo({ volume: 0.9, muted: true });
  const doc = docWith(video);
  assert.equal(controlVideo(doc, 'volup'), 'Volume 100 %');
  assert.equal(video.muted, false, 'monter le son le rétablit');
  assert.equal(controlVideo(doc, 'up'), 'Volume 100 %');
  video.volume = 0.1;
  assert.equal(controlVideo(doc, 'voldown'), 'Volume 0 %');
  assert.equal(controlVideo(doc, 'down'), 'Volume 0 %');
  assert.equal(controlVideo(doc, 'mute'), 'Son coupé');
  assert.equal(controlVideo(doc, 'mute'), 'Son rétabli');
});

test('controlVideo : ignore les vidéos non chargées, prend la plus grande', () => {
  assert.equal(controlVideo(docWith(), 'ok'), '');
  assert.equal(controlVideo(docWith(fakeVideo({ readyState: 0 })), 'ok'), '', 'lecteur pas encore démarré');
  const small = fakeVideo({ videoWidth: 320, videoHeight: 180 });
  const big = fakeVideo();
  controlVideo(docWith(small, big), 'ok');
  assert.equal(big.paused, true);
  assert.equal(small.paused, false);
  assert.equal(controlVideo(docWith(big), 'back'), '', 'touche sans effet sur la vidéo');
});

test('controlVideo : flux en direct (durée infinie) ne plante pas', () => {
  const live = fakeVideo({ duration: Infinity, currentTime: 50 });
  assert.equal(controlVideo(docWith(live), 'forward'), '+30 s');
  assert.equal(live.currentTime, 80);
});

test('fonctions injectées : autonomes une fois sérialisées', () => {
  const rebuiltPick = new Function(`return (${pickNext.toString()})`)();
  assert.equal(rebuiltPick(rect(0, 0), [rect(120, 0)], 'right'), 0);
  const rebuiltControl = new Function(`return (${controlVideo.toString()})`)();
  assert.equal(rebuiltControl(docWith(fakeVideo()), 'ok'), '⏸ Pause');
});

test('interface TV : script valide, sans innerHTML ni console.log', () => {
  const source = readFileSync(new URL('../src/injection/tv-app.js', import.meta.url), 'utf8');
  assert.doesNotThrow(() => new Function(source));
  assert.equal(/innerHTML|insertAdjacentHTML|document\.write/.test(source), false, 'texte externe uniquement via textContent');
  assert.equal(/console\.log/.test(source), false);
});

test('boutons mode TV : activation par vrai clic seulement, sortie dans le menu latéral', () => {
  const preload = readFileSync(new URL('../src/preload.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/injection/tv-app.js', import.meta.url), 'utf8');
  const handler = preload.slice(preload.indexOf("button.addEventListener('click'"), preload.indexOf('return button;'));
  assert.ok(handler.indexOf('isTrusted') > 0 && handler.indexOf('isTrusted') < handler.indexOf("invoke('tv:enter')"), 'le clic simulé est écarté avant l’appel');
  assert.equal(/exposeInMainWorld[^;]*tv:enter/.test(preload), false);
  assert.equal(preload.includes("api.enterTv") || preload.includes("enter: ()"), false, 'l’activation n’est pas exposée à la page');
  assert.ok(app.includes("'data-fk': 'nav:exit'") && app.includes('Quitter le mode TV'));
});

test('config : mode TV par défaut coupé, --tv et MOVIX_TV l’imposent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mewflix-cfg-'));
  try {
    assert.equal(new AppConfig(dir, { argv: [], env: {} }).tvModeEnabled, false);
    assert.equal(new AppConfig(dir, { argv: ['app', '--tv'], env: {} }).tvModeEnabled, true);
    assert.equal(new AppConfig(dir, { argv: [], env: { MOVIX_TV: '1' } }).tvModeEnabled, true);
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ tvMode: true, tvRemotePort: 80 }));
    const saved = new AppConfig(dir, { argv: [], env: {} });
    assert.equal(saved.tvModeEnabled, true, 'réglage enregistré');
    assert.equal(saved.tvRemotePort, 8765, 'port hors plage : valeur par défaut');
    assert.equal(new AppConfig(dir, { argv: ['--tv=off'], env: {} }).tvModeEnabled, false, 'la ligne de commande prime');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
