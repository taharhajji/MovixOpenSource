#!/usr/bin/env node
/**
 * Serveur local qui reproduit le déploiement Vercel : fichiers statiques de
 * web/dist avec repli SPA, et relais /api/* vers l'API Movix sans en-tête
 * Origin (comme la fonction Edge web/api/[...path].js).
 *
 *   node web/scripts/serve-local.mjs [--port 4312] [--upstream https://api.movix.luxe]
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, '..', 'dist');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const PORT = Number(arg('port', process.env.PORT || 4312));
const UPSTREAM = arg('upstream', process.env.UPSTREAM_API || 'https://api.movix.luxe').replace(/\/+$/, '');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
};

const DROP_REQUEST = new Set(['host', 'origin', 'referer', 'connection', 'content-length', 'accept-encoding']);
const DROP_RESPONSE = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive',
  'access-control-allow-origin', 'access-control-allow-credentials']);

async function proxy(req, res) {
  const target = `${UPSTREAM}${req.url}`;
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (DROP_REQUEST.has(name) || name.startsWith('x-forwarded-')) continue;
    headers[name] = value;
  }
  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks);
  }
  try {
    const upstream = await fetch(target, { method: req.method, headers, body, redirect: 'manual' });
    const out = {};
    upstream.headers.forEach((value, name) => { if (!DROP_RESPONSE.has(name)) out[name] = value; });
    out['x-mewflix-proxy'] = 'local';
    res.writeHead(upstream.status, out);
    if (upstream.body) {
      for await (const chunk of upstream.body) res.write(chunk);
    }
    res.end();
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'upstream_unreachable', detail: String(err && err.message) }));
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let file = normalize(join(DIST, decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
  const ext = extname(file).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  createReadStream(file).pipe(res);
}

createServer((req, res) => {
  if (req.url.startsWith('/api/')) return proxy(req, res);
  return serveStatic(req, res);
}).listen(PORT, () => {
  console.log(`[serve-local] http://localhost:${PORT}  (dist: ${DIST}, API → ${UPSTREAM})`);
});
