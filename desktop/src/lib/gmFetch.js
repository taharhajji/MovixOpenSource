'use strict';

/**
 * Exécution native des GM_xmlhttpRequest du userscript, dans le processus
 * principal (pas de CORS, en-têtes libres : Origin, Referer, User-Agent,
 * Cookie…). Port de `handleGMFetch` / `fetchWithRedirectHeaders` du pont mobile
 * (app/src/services/bridge.ts), sur `net.request` d'Electron.
 *
 * Les redirections sont suivies à la main (5 sauts max) pour ré-appliquer les
 * règles d'en-têtes de l'hébergeur à chaque saut.
 */

const { net } = require('electron');
const { applyMediaProxyHeaderRules } = require('./mediaProxyHeaders');

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_BODY_BYTES = 256 * 1024 * 1024;

/** @type {Map<string, { abort: () => void }>} */
const inflight = new Map();

function headersObjectToString(headers) {
  return Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\r\n');
}

function flattenResponseHeaders(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (Array.isArray(value)) {
      out[key] = key.toLowerCase() === 'set-cookie' ? value.join('\n') : value.join(', ');
    } else if (value != null) {
      out[key] = String(value);
    }
  }
  return out;
}

function charsetFrom(headers) {
  const contentType = headers['content-type'] || headers['Content-Type'] || '';
  const match = /charset=["']?([a-z0-9_-]+)/i.exec(contentType);
  return match ? match[1].toLowerCase() : null;
}

function decodeText(buffer, headers) {
  const charset = charsetFrom(headers);
  if (charset && charset !== 'utf-8' && charset !== 'utf8') {
    try {
      return new TextDecoder(charset).decode(buffer);
    } catch {
      // charset inconnu : utf-8 ci-dessous
    }
  }
  return buffer.toString('utf8');
}

function decodeBody(message) {
  if (message.body == null) return undefined;
  if (message.bodyEncoding === 'base64') return Buffer.from(String(message.body), 'base64');
  return Buffer.from(String(message.body), 'utf8');
}

/**
 * Une seule requête HTTP, sans suivre les redirections.
 * Résout avec { redirectUrl, status } ou { status, statusText, headers, buffer, finalUrl }.
 */
function singleRequest({ url, method, headers, body, session, useSessionCookies, signal }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    let request;
    try {
      request = net.request({
        url,
        method,
        session,
        useSessionCookies,
        redirect: 'manual',
      });
    } catch (err) {
      finish(reject, err);
      return;
    }

    const onAbort = () => {
      try {
        request.abort();
      } catch {
        // déjà terminé
      }
      finish(reject, Object.assign(new Error('Requête annulée'), { code: 'ABORTED' }));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const cleanup = () => signal && signal.removeEventListener('abort', onAbort);

    for (const [name, value] of Object.entries(headers)) {
      if (value == null || value === '') continue;
      try {
        request.setHeader(name, String(value));
      } catch {
        // en-tête refusé par Chromium : ignoré, comme le ferait le navigateur
      }
    }

    request.on('redirect', (statusCode, _method, redirectUrl) => {
      cleanup();
      try {
        request.abort();
      } catch {
        // rien
      }
      finish(resolve, { redirectUrl, status: statusCode });
    });

    request.on('response', (response) => {
      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          try {
            request.abort();
          } catch {
            // rien
          }
          cleanup();
          finish(reject, new Error('Réponse trop volumineuse'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        cleanup();
        finish(resolve, {
          status: response.statusCode,
          statusText: response.statusMessage || '',
          headers: flattenResponseHeaders(response.headers),
          buffer: Buffer.concat(chunks),
          finalUrl: url,
        });
      });
      response.on('error', (err) => {
        cleanup();
        finish(reject, err);
      });
      response.on('aborted', () => {
        cleanup();
        finish(reject, Object.assign(new Error('Réponse interrompue'), { code: 'ABORTED' }));
      });
    });

    request.on('error', (err) => {
      cleanup();
      finish(reject, err);
    });
    request.on('abort', () => {
      cleanup();
      finish(reject, Object.assign(new Error('Requête annulée'), { code: 'ABORTED' }));
    });

    if (body && method !== 'GET' && method !== 'HEAD') {
      request.write(body);
    }
    request.end();
  });
}

/**
 * @param {object} message  { id, url, method, headers, body, bodyEncoding, responseType, timeout, anonymous }
 * @param {Electron.Session} session
 */
async function gmFetch(message, session) {
  const id = String(message.id || '');
  const url = String(message.url || '');
  if (!/^https?:\/\//i.test(url)) {
    return { id, success: false, error: 'URL non supportée' };
  }

  const controller = new AbortController();
  if (id) inflight.set(id, { abort: () => controller.abort() });
  const timeoutMs = Number(message.timeout) > 0 ? Number(message.timeout) : DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let timedOut = false;
  controller.signal.addEventListener('abort', () => {
    timedOut = inflight.has(id);
  }, { once: true });

  try {
    let currentUrl = url;
    let method = String(message.method || 'GET').toUpperCase();
    let body = decodeBody(message);
    const baseHeaders = { ...(message.headers || {}) };
    const useSessionCookies = message.anonymous !== true;

    let result = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const headers = applyMediaProxyHeaderRules(currentUrl, { ...baseHeaders });
      const outcome = await singleRequest({
        url: currentUrl,
        method,
        headers,
        body,
        session,
        useSessionCookies,
        signal: controller.signal,
      });
      if (outcome.redirectUrl) {
        if (hop === MAX_REDIRECTS) {
          return { id, success: false, error: 'Trop de redirections' };
        }
        currentUrl = new URL(outcome.redirectUrl, currentUrl).href;
        if (outcome.status === 307 || outcome.status === 308) {
          // méthode et corps conservés
        } else {
          method = 'GET';
          body = undefined;
        }
        continue;
      }
      result = outcome;
      break;
    }

    const wantsBinary = message.responseType === 'arraybuffer' || message.responseType === 'blob';
    return {
      id,
      success: true,
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
      body: wantsBinary ? result.buffer.toString('base64') : decodeText(result.buffer, result.headers),
      bodyEncoding: wantsBinary ? 'base64' : 'text',
      finalUrl: result.finalUrl,
    };
  } catch (err) {
    const aborted = err && err.code === 'ABORTED';
    return {
      id,
      success: false,
      timedOut: aborted && timedOut,
      error: aborted
        ? (timedOut ? 'Délai dépassé' : 'Requête annulée')
        : (err && err.message) || 'Requête échouée',
    };
  } finally {
    clearTimeout(timer);
    if (id) inflight.delete(id);
  }
}

function abortGmRequest(id) {
  const entry = inflight.get(String(id));
  if (!entry) return false;
  inflight.delete(String(id));
  entry.abort();
  return true;
}

module.exports = { gmFetch, abortGmRequest, headersObjectToString, flattenResponseHeaders };
