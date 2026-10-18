// Minimal HTTP layer on node:http: a router, JSON bodies, static files and
// security headers. Kept dependency-free on purpose: a process that holds
// production credentials should have as small a supply chain as practical.

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code ?? `http_${status}`;
    this.expose = true;
  }
}

export function createRouter() {
  const routes = [];
  const add = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
    routes.push({ method, re, keys, handler });
  };
  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    match(method, pathname) {
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        return { handler: r.handler, params };
      }
      return pathMatched ? { methodNotAllowed: true } : null;
    },
  };
}

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const MAX_BODY_BYTES = 16 * 1024;

async function readJsonBody(req) {
  if (req.method !== 'POST') return undefined;
  const type = req.headers['content-type'] ?? '';
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  // Requiring application/json also blocks simple cross-site form posts (CSRF).
  if (!type.startsWith('application/json')) throw new HttpError(415, 'content-type must be application/json');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

export function createHttpServer({ router, staticDir, logger, redactor, isProduction }) {
  const log = logger.child({ component: 'http' });
  const root = path.resolve(staticDir);

  function sendJson(res, status, payload) {
    // Last-mile scrub on API responses too: defense in depth.
    const body = redactor.scrubString(JSON.stringify(payload));
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  }

  async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method_not_allowed' });
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.resolve(root, rel);
    if (file !== root && !file.startsWith(root + path.sep)) return sendJson(res, 404, { error: 'not_found' });
    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error('not a file');
      const data = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      sendJson(res, 404, { error: 'not_found' });
    }
  }

  return http.createServer(async (req, res) => {
    const started = performance.now();
    const requestId = randomUUID();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    res.setHeader('X-Request-Id', requestId);

    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return sendJson(res, 400, { error: 'bad_request' });
    }

    try {
      if (!pathname.startsWith('/api/')) return await serveStatic(req, res, pathname);

      const match = router.match(req.method, pathname);
      if (!match) throw new HttpError(404, 'not found');
      if (match.methodNotAllowed) throw new HttpError(405, 'method not allowed');

      const ctx = { req, params: match.params, query: new URL(req.url, 'http://localhost').searchParams, status: 200, requestId };
      ctx.body = await readJsonBody(req);
      const result = await match.handler(ctx);
      sendJson(res, ctx.status, result ?? { ok: true });
    } catch (err) {
      const status = err.expose ? err.status : 500;
      if (status >= 500) log.error({ err, requestId, path: pathname }, 'request failed');
      // Never send internal error details (which may describe infrastructure) to clients in production.
      const message = err.expose || !isProduction ? err.message : 'internal error';
      sendJson(res, status, { error: err.expose ? err.code : 'internal_error', message, requestId });
    } finally {
      if (pathname?.startsWith('/api/')) {
        log.debug({ method: req.method, path: pathname, status: res.statusCode, ms: +(performance.now() - started).toFixed(1) }, 'request');
      }
    }
  });
}
