import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const { pickAsset, expectedSha256, macBundleFromExe, isTranslocated, macSwapScript, shellQuote, download, createSelfUpdater } = require('../src/lib/selfUpdate.js');

const GH = 'https://github.com/taharhajji/MovixOpenSource/releases/download/v1.2.0/';
const ASSETS = [
  { name: 'MEWFLIX-Setup-1.2.0.exe', browser_download_url: `${GH}MEWFLIX-Setup-1.2.0.exe` },
  { name: 'MEWFLIX-1.2.0-mac-arm64.zip', browser_download_url: `${GH}MEWFLIX-1.2.0-mac-arm64.zip` },
  { name: 'MEWFLIX-1.2.0-mac-x64.zip', browser_download_url: `${GH}MEWFLIX-1.2.0-mac-x64.zip` },
  { name: 'MEWFLIX-1.2.0-linux-amd64.deb', browser_download_url: `${GH}MEWFLIX-1.2.0-linux-amd64.deb` },
  { name: 'MEWFLIX-1.2.0-linux-arm64.deb', browser_download_url: 'https://evil.example/x.deb' },
];

test('choix du fichier selon le système et le processeur', () => {
  assert.equal(pickAsset(ASSETS, 'darwin', 'arm64').name, 'MEWFLIX-1.2.0-mac-arm64.zip');
  assert.equal(pickAsset(ASSETS, 'darwin', 'x64').name, 'MEWFLIX-1.2.0-mac-x64.zip');
  assert.equal(pickAsset(ASSETS, 'linux', 'x64').name, 'MEWFLIX-1.2.0-linux-amd64.deb');
  assert.equal(pickAsset(ASSETS, 'linux', 'arm64'), null, 'hôte autre que github.com refusé');
  assert.equal(pickAsset(ASSETS, 'win32', 'x64'), null);
  assert.equal(pickAsset(null, 'darwin', 'arm64'), null);
});

test('empreinte attendue lue dans le champ digest', () => {
  const hex = 'a'.repeat(64);
  assert.equal(expectedSha256({ digest: `sha256:${hex}` }), hex);
  assert.equal(expectedSha256({ digest: 'md5:abc' }), '');
  assert.equal(expectedSha256({}), '');
});

test('chemin du paquet .app et emplacements isolés', () => {
  assert.equal(macBundleFromExe('/Applications/MEWFLIX.app/Contents/MacOS/MEWFLIX'), '/Applications/MEWFLIX.app');
  assert.equal(macBundleFromExe('/usr/bin/mewflix'), '');
  assert.ok(isTranslocated('/private/var/folders/x/AppTranslocation/ABC/d/MEWFLIX.app'));
  assert.ok(isTranslocated('/Volumes/MEWFLIX/MEWFLIX.app'));
  assert.ok(!isTranslocated('/Applications/MEWFLIX.app'));
});

test('guillemets du script : chemin piégé neutralisé', () => {
  assert.equal(shellQuote("a'b"), `'a'\\''b'`);
  const script = macSwapScript({ pid: 42, current: "/Applications/MEW'; rm -rf ~; '.app", fresh: '/tmp/u/app/MEWFLIX.app', workDir: '/tmp/u' });
  assert.ok(script.includes(`'/Applications/MEW'\\''; rm -rf ~; '\\''.app'`));
  assert.ok(script.includes('kill -0 42'));
});

function hasSh() {
  try { execFileSync('sh', ['-c', 'true']); return true; } catch { return false; }
}
// Git Bash (Windows) attend des chemins /c/… ; ailleurs, chemins tels quels.
function toSh(p) {
  return process.platform === 'win32' ? p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`) : p;
}

test('script de remplacement : nouvelle version en place, ancienne retirée (sh réel)', { skip: !hasSh() }, () => {
  const root = mkdtempSync(join(tmpdir(), 'mewflix-swap-'));
  const current = join(root, 'Applications', 'MEWFLIX.app');
  const workDir = join(root, 'work');
  const fresh = join(workDir, 'app', 'MEWFLIX.app');
  mkdirSync(current, { recursive: true });
  writeFileSync(join(current, 'version'), 'old');
  mkdirSync(fresh, { recursive: true });
  writeFileSync(join(fresh, 'version'), 'new');
  const script = macSwapScript({ pid: 999999, current: toSh(current), fresh: toSh(fresh), workDir: toSh(workDir) }).replace(/\nopen .*\n$/, '\n');
  const file = join(root, 'swap.sh');
  writeFileSync(file, script);
  execFileSync('sh', [toSh(file)]);
  assert.equal(readFileSync(join(current, 'version'), 'utf8'), 'new');
  assert.ok(!existsSync(`${current}.ancienne-version`));
  assert.ok(!existsSync(workDir));
});

function fakeResponse(bytes) {
  return { ok: true, status: 200, body: new Response(bytes).body };
}

test('téléchargement : taille et empreinte vérifiées', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mewflix-dl-'));
  const data = Buffer.from('paquet MEWFLIX');
  const sha = createHash('sha256').update(data).digest('hex');
  const ok = await download(async () => fakeResponse(data), `${GH}a.deb`, join(dir, 'a.deb'), { size: data.length, sha256: sha });
  assert.equal(ok.bytes, data.length);
  await assert.rejects(download(async () => fakeResponse(data), `${GH}b.deb`, join(dir, 'b.deb'), { sha256: 'b'.repeat(64) }), /empreinte/);
  await assert.rejects(download(async () => fakeResponse(data), `${GH}c.deb`, join(dir, 'c.deb'), { size: 3 }), /taille/);
  await assert.rejects(download(async () => fakeResponse(data), 'https://evil.example/d.deb', join(dir, 'd.deb')), /refusée/);
});

test('vérification : version récente téléchargée une seule fois, rien si déjà à jour', async () => {
  const data = Buffer.from('deb');
  const sha = createHash('sha256').update(data).digest('hex');
  let downloads = 0;
  const release = { tag_name: 'v1.2.0', assets: [{ name: 'MEWFLIX-1.2.0-linux-amd64.deb', size: data.length, digest: `sha256:${sha}`, browser_download_url: `${GH}MEWFLIX-1.2.0-linux-amd64.deb` }] };
  const fetchImpl = async (url) => {
    if (url.includes('api.github.com')) return { ok: true, status: 200, json: async () => release };
    downloads += 1;
    return fakeResponse(data);
  };
  const isNewer = (a, b) => a.localeCompare(b, undefined, { numeric: true }) > 0;
  const updater = createSelfUpdater({ app: { getVersion: () => '1.1.5' }, fetchImpl, releasesApi: 'https://api.github.com/x', isNewer, platform: 'linux', arch: 'x64' });
  const first = await updater.check();
  assert.equal(first.status, 'ready');
  assert.equal(first.version, '1.2.0');
  await updater.check();
  assert.equal(downloads, 1, 'pas de second téléchargement');

  const upToDate = createSelfUpdater({ app: { getVersion: () => '1.2.0' }, fetchImpl, releasesApi: 'https://api.github.com/x', isNewer, platform: 'linux', arch: 'x64' });
  assert.equal((await upToDate.check()).status, 'none');
});
