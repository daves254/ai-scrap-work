import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import express from 'express';
import {
  PairingCallbackServer,
  encryptToken,
  decryptToken,
  parseAppAccessUrl,
} from './pairing-callback.ts';

const TOKEN = 'super-secret-automation-token';
const APP_BASE = 'https://app.example.com/hook';
const DEVICE = 'phone-123';

function accessUrl(nonce: string): string {
  return `${APP_BASE}/${DEVICE}/${encryptToken(TOKEN, nonce)}`;
}

// 1) crypto round-trip + URL parsing -----------------------------------------
{
  const nonce = 'test-nonce';
  assert.equal(decryptToken(encryptToken(TOKEN, nonce), nonce), TOKEN);
  assert.throws(() => decryptToken(encryptToken(TOKEN, nonce), 'wrong-nonce'));
  const p = parseAppAccessUrl(accessUrl(nonce));
  assert.equal(p.baseUrl, APP_BASE);
  assert.equal(p.deviceId, DEVICE);
  console.log('  ok  crypto round-trip + parseAppAccessUrl');
}

// 2) STANDALONE http server ---------------------------------------------------
{
  const s = await new PairingCallbackServer({ port: 0, deviceName: 'MyLaptop' }).start();
  const url = s.url;

  const info = await (await fetch(url)).json();
  assert.equal(info.deviceName, 'MyLaptop');
  assert.equal(info.nonce, s.nonce);

  const post = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: accessUrl(s.nonce), name: 'Pixel' }),
  });
  assert.equal(post.status, 200);

  const reg = await s.waitForDevice();
  assert.equal(reg.token, TOKEN);
  assert.equal(reg.baseUrl, APP_BASE);
  assert.equal(reg.deviceId, DEVICE);
  assert.equal(reg.name, 'Pixel');
  await s.stop();
  console.log('  ok  standalone http server (own port)');
}

// 3) BARE middleware with mock req/res (no express) ---------------------------
{
  const s = new PairingCallbackServer({ publicUrl: 'https://host.example.com/aat', deviceName: 'DeskPC' });
  const mw = s.middleware();
  assert.equal(s.url, `https://host.example.com/aat/pair/${s.nonce}`);

  const call = (req: any): Promise<{ code: number; body: any }> =>
    new Promise((resolve) => {
      const res: any = {
        _code: 200,
        setHeader() {},
        status(c: number) {
          this._code = c;
          return this;
        },
        json(b: unknown) {
          resolve({ code: this._code, body: b });
        },
      };
      mw(req, res, () => resolve({ code: -1, body: 'next()' }));
    });

  // Non-matching path -> next()
  assert.equal((await call({ method: 'GET', path: '/other' })).code, -1);

  // GET the device info
  const got = await call({ method: 'GET', path: `/pair/${s.nonce}` });
  assert.equal(got.code, 200);
  assert.equal(got.body.deviceName, 'DeskPC');

  // POST with a pre-parsed body (as express.json() would provide)
  const posted = await call({ method: 'POST', path: `/pair/${s.nonce}`, body: { url: accessUrl(s.nonce) } });
  assert.equal(posted.code, 200);

  const reg = await s.waitForDevice();
  assert.equal(reg.token, TOKEN);
  await s.stop();
  console.log('  ok  bare middleware + mock req/res (next() fall-through)');
}

// 4) Real EXPRESS router, mounted under a base path ---------------------------
{
  const s = new PairingCallbackServer({ deviceName: 'ServerBox' });
  const app = express();
  app.use(express.json());
  app.use('/aat', (await s.router(express)) as express.Router);

  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}/aat/pair/${s.nonce}`;

  const info = await (await fetch(base)).json();
  assert.equal(info.deviceName, 'ServerBox');

  const post = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: accessUrl(s.nonce) }),
  });
  assert.equal(post.status, 200);

  const reg = await s.waitForDevice();
  assert.equal(reg.token, TOKEN);
  assert.equal(reg.deviceId, DEVICE);

  // Unrelated route still works (router fell through).
  app.get('/ping', (_req, res) => res.json({ pong: true }));
  const ping = await (await fetch(`http://127.0.0.1:${port}/ping`)).json();
  assert.equal(ping.pong, true);

  await s.stop();
  server.close();
  console.log('  ok  express Router mounted at /aat (+ fall-through)');
}

// 5) expired code returns 410 (and the TTL timeout rejects waitForDevice) -----
{
  const s = new PairingCallbackServer({ publicUrl: 'https://h/x', ttlMs: 5 });
  const timedOut = s.waitForDevice().then(
    () => false,
    (e: Error) => /timed out/.test(e.message),
  );
  const mw = s.middleware();
  await new Promise((r) => setTimeout(r, 25)); // let it expire

  const { code, body } = await new Promise<{ code: number; body: any }>((resolve) => {
    const res: any = {
      _code: 200,
      setHeader() {},
      status(c: number) {
        this._code = c;
        return this;
      },
      json(b: unknown) {
        resolve({ code: this._code, body: b });
      },
    };
    mw({ method: 'GET', path: `/pair/${s.nonce}` } as any, res, () => resolve({ code: -1, body: 'next()' }));
  });

  assert.equal(code, 410);
  assert.match(body.error, /expired/);
  assert.equal(await timedOut, true);
  await s.stop();
  console.log('  ok  expired code -> 410 and waitForDevice() rejects on timeout');
}

console.log('\nAll pairing-callback smoke tests passed.');
process.exit(0);
