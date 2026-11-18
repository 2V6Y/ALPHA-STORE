import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';

test('demo order, protected admin workflow and persistence', async () => {
  const location = await mkdtemp(join(tmpdir(), 'alpha-store-'));
  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  listener.close();
  await once(listener, 'close');

  const origin = 'http://127.0.0.1:' + port;
  const password = 'test only random fixture 123456';
  let server;
  let cookie;
  async function start() {
    server = spawn(process.execPath, ['server.js'], {
      env: { ...process.env, RENDER: 'false', PORT: String(port), HOST: '127.0.0.1',
        PUBLIC_ORIGIN: origin, DATA_DIR: location, ADMIN_PASSWORD: password },
      stdio: 'inherit',
    });
    for (let attempt = 0; attempt < 50; attempt++) {
      const health = await fetch(origin + '/health').catch(() => null);
      if (health?.ok) {
        await health.json();
        return;
      }
      if (server.exitCode !== null) break;
      await setTimeout(100);
    }
    throw new Error('Server failed to start');
  }
  async function stop() {
    if (server && server.exitCode === null && server.signalCode === null) {
      const ended = once(server, 'exit');
      server.kill();
      await ended;
    }
  }
  const call = (path, { method = 'GET', body, auth = false, from = origin } = {}) =>
    fetch(origin + path, { method, headers: {
      Origin: from,
      ...(auth ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, body: JSON.stringify(body) });

  try {
    await start();
    assert.match(await (await call('/')).text(), /إرسال طلب تجريبي/);
    assert.match(await (await call('/admin')).text(), /إدارة الطلبات التجريبية/);
    assert.equal((await call('/server.js')).status, 404);
    assert.equal((await call('/api/admin/orders')).status, 401);
    assert.equal((await call('/api/orders', {method: 'POST', body: {items: [0]}, from: 'https://other.invalid'})).status, 403);
    assert.equal((await call('/api/orders', {method: 'POST', body: {items: [99]}})).status, 400);
    const orderResponse = await call('/api/orders', {method: 'POST', body: {items: [0, 1], total: 1}});
    assert.equal(orderResponse.status, 201);
    const order = await orderResponse.json();
    assert.equal(order.total, 60);
    assert.equal(order.status, 'new');

    const login = () => call('/api/admin/login', {method: 'POST', body: {password}});
    assert.equal((await call('/api/admin/login', {method: 'POST', body: {password: 'wrong'}})).status, 401);
    const session = await login();
    assert.equal(session.status, 200);
    const header = session.headers.get('set-cookie');
    assert.match(header, /HttpOnly; SameSite=Strict/);
    cookie = header.split(';')[0];
    const listing = () => call('/api/admin/orders', {auth: true});
    assert.equal((await (await listing()).json()).orders[0].id, order.id);
    const change = (status, auth) => call('/api/admin/orders/' + order.id, {
      method: 'PATCH', body: {status}, auth,
    });
    assert.equal((await change('reviewed', false)).status, 401);
    assert.equal((await change('paid', true)).status, 400);
    assert.equal((await change('reviewed', true)).status, 200);
    assert.equal((await call('/api/admin/logout', {method: 'POST', auth: true})).status, 200);
    assert.equal((await listing()).status, 401);

    await stop();
    await start();
    cookie = (await login()).headers.get('set-cookie').split(';')[0];
    assert.equal((await (await listing()).json()).orders[0].status, 'reviewed');
  } finally {
    await stop();
    await rm(location, { recursive: true, force: true });
  }
});
