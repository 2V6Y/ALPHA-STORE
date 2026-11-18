import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const read = name => readFileSync(new URL(name, import.meta.url));
const catalog = JSON.parse(read('catalog.json'));
const files = new Map([
  ['/', ['text/html; charset=utf-8', read('index.html')]],
  ['/admin', ['text/html; charset=utf-8', read('admin.html')]],
  ['/admin.js', ['text/javascript; charset=utf-8', read('admin.js')]],
  ['/catalog.json', ['application/json; charset=utf-8', read('catalog.json')]],
]);
const data = process.env.DATA_DIR || 'data';
if (process.env.RENDER === 'true' && !process.env.DATA_DIR) {
  throw new Error('Set DATA_DIR to a directory on the persistent disk.');
}
mkdirSync(data, { recursive: true });
const db = new DatabaseSync(join(data, 'orders.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, items TEXT NOT NULL, total INTEGER NOT NULL,
    created TEXT NOT NULL, status TEXT NOT NULL
      CHECK (status IN ('new', 'reviewed', 'cancelled'))
  );
  CREATE INDEX IF NOT EXISTS orders_created ON orders(created DESC);
`);

const hash = value => createHash('sha256').update(value).digest();
const password = process.env.ADMIN_PASSWORD;
if (password && password.length < 24) throw new Error('ADMIN_PASSWORD must contain at least 24 characters.');
const expected = password && hash(password);
const publicOrigin = process.env.PUBLIC_ORIGIN && new URL(process.env.PUBLIC_ORIGIN).origin;
if (process.env.RENDER === 'true' && !publicOrigin?.startsWith('https://')) {
  throw new Error('Set PUBLIC_ORIGIN to the HTTPS service origin.');
}
const secureCookie = publicOrigin?.startsWith('https://') ? '; Secure' : '';
const sessions = new Map();
const limits = new Map();
const statuses = new Set(['new', 'reviewed', 'cancelled']);
const send = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
};

function allow(key, maximum, duration) {
  const now = Date.now();
  const entry = limits.get(key);
  if (!entry || entry.until <= now) limits.set(key, { count: 1, until: now + duration });
  else if (entry.count >= maximum) return false;
  else entry.count++;
  return true;
}

const sessionDuration = 30 * 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [id, until] of sessions) if (until <= now) sessions.delete(id);
  for (const [id, entry] of limits) if (entry.until <= now) limits.delete(id);
}, 60_000).unref();

async function json(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw Object.assign(new Error('Expected JSON'), { status: 415 });
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 4096) {
      req.resume();
      throw Object.assign(new Error('Body too large'), { status: 413 });
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && files.has(path)) {
      const [type, content] = files.get(path);
      if (path.startsWith('/admin')) {
        res.setHeader('Content-Security-Policy',
          "default-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      }
      res.writeHead(200, { 'Content-Type': type });
      return res.end(content);
    }
    if (req.method === 'GET' && path === '/health') {
      db.prepare('SELECT 1').get();
      return send(res, 200, { ok: true });
    }

    const origin = publicOrigin || `http://${req.headers.host}`;
    if (['POST', 'PATCH'].includes(req.method) && req.headers.origin !== origin) {
      return send(res, 403, { error: 'origin' });
    }

    if (req.method === 'POST' && path === '/api/orders') {
      // Global ceiling plus per-client quota. On Render, the proxy appends the caller address.
      const client = process.env.RENDER === 'true'
        ? (req.headers['x-forwarded-for']?.split(',').at(-1).trim() || req.socket.remoteAddress)
        : req.socket.remoteAddress;
      if (!allow('order:' + client, 12, 60_000) || !allow('orders', 120, 60_000)) {
        return send(res, 429, { error: 'rate_limit' });
      }
      const { items } = await json(req);
      if (!Array.isArray(items) || !items.length || items.length > 20 ||
          !items.every(id => Number.isInteger(id) && id >= 0 && id < catalog.length)) {
        return send(res, 400, { error: 'items' });
      }
      const orderItems = items.map(id => catalog[id]);
      const total = orderItems.reduce((sum, [, price]) => sum + price, 0);
      const id = randomBytes(12).toString('hex');
      db.prepare('INSERT INTO orders VALUES (?, ?, ?, ?, ?)').run(
        id, JSON.stringify(orderItems), total, new Date().toISOString(), 'new');
      return send(res, 201, { id, total, status: 'new' });
    }

    if (req.method === 'POST' && path === '/api/admin/login') {
      if (!expected) return send(res, 503, { error: 'admin_disabled' });
      if (!allow('login', 10, 15 * 60_000)) return send(res, 429, { error: 'rate_limit' });
      const body = await json(req);
      if (typeof body.password !== 'string' || !timingSafeEqual(hash(body.password), expected)) {
        return send(res, 401, { error: 'credentials' });
      }
      limits.delete('login');
      const id = randomBytes(32).toString('hex');
      sessions.set(id, Date.now() + sessionDuration);
      res.setHeader('Set-Cookie', `alpha_session=${id}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=1800${secureCookie}`);
      return send(res, 200, { ok: true });
    }

    if (path.startsWith('/api/admin/')) {
      const session = req.headers.cookie?.match(/(?:^|;\s*)alpha_session=([a-f0-9]{64})(?:;|$)/)?.[1];
      if (!(sessions.get(session) > Date.now())) return send(res, 401, { error: 'session' });
      if (req.method === 'POST' && path === '/api/admin/logout') {
        sessions.delete(session);
        res.setHeader('Set-Cookie', `alpha_session=; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=0${secureCookie}`);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && path === '/api/admin/orders') {
        const page = Number(new URL(req.url, 'http://localhost').searchParams.get('page') || 0);
        if (!Number.isSafeInteger(page) || page < 0 || page > 1_000_000) return send(res, 400, { error: 'page' });
        const rows = db.prepare('SELECT * FROM orders ORDER BY created DESC, id DESC LIMIT 51 OFFSET ?').all(page * 50);
        return send(res, 200, {
          orders: rows.slice(0, 50).map(row => ({ ...row, items: JSON.parse(row.items) })),
          more: rows.length > 50,
        });
      }
      const match = path.match(/^\/api\/admin\/orders\/([a-f0-9]{24})$/);
      if (req.method === 'PATCH' && match) {
        const { status } = await json(req);
        if (!statuses.has(status)) return send(res, 400, { error: 'status' });
        const result = db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, match[1]);
        return send(res, result.changes ? 200 : 404, result.changes ? { status } : { error: 'not_found' });
      }
    }

    return send(res, 404, { error: 'not_found' });
  } catch (error) {
    if (!error.status) console.error(error);
    return send(res, error.status || 500, { error: error.status ? 'request' : 'server' });
  }
});

server.listen(Number(process.env.PORT || 3000), process.env.HOST || '0.0.0.0');
