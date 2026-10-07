'use strict';

/**
 * Diagnostic : exécute gmFetch (le GM_xmlhttpRequest natif de l'app) sur des
 * URLs, avec et sans règles d'en-têtes, et compare à un net.request nu.
 *
 * Usage : npx electron scripts/gm-probe.js <url> [url...]
 */

const { app, net, session } = require('electron');
const { gmFetch } = require('../src/lib/gmFetch');
const { applyMediaProxyHeaderRules } = require('../src/lib/mediaProxyHeaders');

// URLs en argument ou dans PROBE_URLS (séparées par des virgules) : sous Git
// Bash, plusieurs URLs en arguments font parfois sortir Electron en 127.
const urls = String(process.env.PROBE_URLS || '')
  .split(',')
  .concat(process.argv.slice(2))
  .map((a) => a.trim())
  .filter((a) => /^https?:\/\//.test(a));

function rawRequest(url, headers) {
  return new Promise((resolve) => {
    const req = net.request({ url, session: session.defaultSession, redirect: 'follow' });
    for (const [k, v] of Object.entries(headers || {})) {
      try { req.setHeader(k, v); } catch (e) { resolve({ error: `setHeader(${k}) : ${e.message}` }); return; }
    }
    req.on('response', (res) => {
      let size = 0;
      res.on('data', (c) => { size += c.length; });
      res.on('end', () => resolve({ status: res.statusCode, size }));
      res.on('error', (e) => resolve({ error: e.message }));
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.end();
  });
}

app.whenReady().then(async () => {
  if (process.env.PROBE_DOH === '1') {
    app.configureHostResolver({
      enableBuiltInResolver: true,
      secureDnsMode: 'secure',
      secureDnsServers: ['https://cloudflare-dns.com/dns-query', 'https://dns.google/dns-query'],
    });
    console.log('DoH actif');
  }
  // Détail des erreurs de certificat (émetteur, sujet, code) sans rien contourner.
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    if (request.verificationResult !== 'net::OK') {
      console.log(`  [cert] ${request.hostname} : ${request.verificationResult} (code ${request.errorCode}) `
        + `émetteur="${request.certificate && request.certificate.issuerName}" sujet="${request.certificate && request.certificate.subjectName}"`);
    }
    callback(-3);
  });
  for (const url of urls) {
    console.log(`\n== ${url}`);
    const plain = await rawRequest(url, {});
    console.log('  net.request nu        :', JSON.stringify(plain));
    const ruled = await rawRequest(url, applyMediaProxyHeaderRules(url, {}));
    console.log('  net.request + règles  :', JSON.stringify(ruled));
    const gm = await gmFetch({ id: 'p', url, method: 'GET', headers: {}, responseType: '' }, session.defaultSession);
    console.log('  gmFetch               :', JSON.stringify({ success: gm.success, status: gm.status, error: gm.error, bytes: gm.body ? gm.body.length : 0, finalUrl: gm.finalUrl }));
  }
  app.exit(0);
});
