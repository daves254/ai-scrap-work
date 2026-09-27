/**
 * Host-side **pairing callback** — the correct direction of the AAT pairing handshake:
 *
 *  1. The **Node host** exposes this callback endpoint and shows its one-time callback URL as a QR
 *     (`http://<host>:<port>/pair/<nonce>`, or a public URL if the host is reachable remotely).
 *  2. The **app** scans that QR (or the URL is pasted into the app). The app `GET`s the callback to
 *     learn the **host's device name** (so the user confirms *which computer* they are pairing with).
 *  3. The **app** `POST`s back its own access URL in the shape `<appUrl>/<deviceId>/<encToken>` — where
 *     `encToken` is the app's automation token **encrypted** with a key derived from the nonce, so
 *     it never travels in the clear. The host decrypts it and now knows how to reach the app.
 *
 * The nonce is single-use and expires (default 5 min).
 *
 * ## Two ways to serve it
 *
 * The endpoint logic is transport-agnostic. Configure it through {@link PairingCallbackOptions} and
 * pick a surface:
 *
 *  - **Standalone** (Node built-ins only, no express): `await server.start()` binds its own `http`
 *    server on `opts.port`. Read `.url` / `.urls` for the QR, then `await server.waitForDevice()`.
 *  - **Mounted in your app**: `server.middleware()` returns an Express-style `(req, res, next)`
 *    handler you can `app.use(...)`, and `await server.router()` returns a ready `express.Router`.
 *    Neither imports express unless you call `router()` (and even then express is only a lazily
 *    resolved *optional* peer). In mounted mode set `opts.publicUrl` to the base the app can reach
 *    (including any mount path) so `.url` can be built for the QR.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { hostname, networkInterfaces } from 'node:os';

/** The app's registration payload (what it POSTs to the callback). */
export interface PairingRegistration {
  deviceId: string;
  /** The decrypted automation token. */
  token: string;
  /** The base URL to reach the app's Device Hook (from its access URL). */
  baseUrl: string;
  /** Optional app-supplied name (e.g. the phone model). */
  name?: string;
}

// --- token crypto (nonce-derived AES-256-GCM) --------------------------------

function keyFromNonce(nonce: string): Buffer {
  return createHash('sha256').update(nonce, 'utf8').digest(); // 32 bytes
}

const b64url = {
  encode: (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  decode: (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
};

/**
 * Encrypt a token with the nonce-derived key → base64url(`iv(12) || ciphertext || tag(16)`). The
 * app performs the equivalent (`AES/GCM/NoPadding`, key = SHA-256(nonce)); exported so tests + the
 * app README can show the exact interop format.
 */
export function encryptToken(token: string, nonce: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFromNonce(nonce), iv);
  const ct = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return b64url.encode(Buffer.concat([iv, ct, cipher.getAuthTag()]));
}

/** Decrypt what {@link encryptToken} (or the app) produced. Throws on tamper/wrong nonce. */
export function decryptToken(enc: string, nonce: string): string {
  const buf = b64url.decode(enc);
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', keyFromNonce(nonce), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * Parse an app access URL `<baseUrl>/<deviceId>/<encToken>` into its parts (baseUrl = everything
 * before the last two path segments).
 */
export function parseAppAccessUrl(url: string): { baseUrl: string; deviceId: string; encToken: string } {
  const u = new URL(url);
  const segs = u.pathname.split('/').filter(Boolean);
  if (segs.length < 2) throw new Error('access URL must be <baseUrl>/<deviceId>/<encToken>');
  const encToken = segs.pop()!;
  const deviceId = segs.pop()!;
  const basePath = segs.length ? '/' + segs.join('/') : '';
  return { baseUrl: `${u.protocol}//${u.host}${basePath}`, deviceId, encToken };
}

// --- LAN IP ------------------------------------------------------------------

/** Best-effort primary LAN IPv4 of this host. */
export function primaryLanIp(): string | null {
  return lanInterfaces()[0]?.address ?? null;
}

/** One reachable network interface. */
export interface NetIface {
  /** Interface name (e.g. `eth0`, `Wi-Fi`), or `localhost`. */
  name: string;
  /** IPv4 address. */
  address: string;
}

/**
 * Every non-internal IPv4 interface of this host, plus `localhost` last. Because a standalone server
 * binds the wildcard address, a device can reach it on ANY of these — so pairing offers one callback
 * URL (and QR) per interface and the user picks the one the device can see.
 */
export function lanInterfaces(): NetIface[] {
  const out: NetIface[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  out.push({ name: 'localhost', address: '127.0.0.1' });
  return out;
}

// --- express-ish transport types (no express dependency) ---------------------

/** Minimal request shape common to Node's `http` and Express (which extends it). */
export interface PairingRequest extends IncomingMessage {
  /** Express-populated path (relative to the mount), if present. */
  path?: string;
  /** Express-populated original URL, if present. */
  originalUrl?: string;
  /** Body pre-parsed by a body parser (e.g. `express.json()`), if present. */
  body?: unknown;
}

/** Minimal response shape common to Node's `http` and Express (which extends it). */
export interface PairingResponse extends ServerResponse {
  status?(code: number): PairingResponse;
  json?(body: unknown): void;
}

export type PairingNext = (err?: unknown) => void;

/** An Express-compatible middleware: mount it with `app.use(...)` or inside a `Router`. */
export type PairingMiddleware = (req: PairingRequest, res: PairingResponse, next?: PairingNext) => void;

/** Write a JSON response to either a Node `http` response or an Express one. */
function writeJson(res: PairingResponse, code: number, body: unknown): void {
  try {
    res.setHeader('cache-control', 'no-store');
  } catch {
    /* headers may already be sent */
  }
  if (typeof res.status === 'function' && typeof res.json === 'function') {
    const r = res as ServerResponse & { status(c: number): unknown; json(b: unknown): void };
    r.status(code);
    r.json(body);
    return;
  }
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// --- the callback endpoint ---------------------------------------------------

export interface PairingCallbackOptions {
  /** Standalone only: bind port (default an ephemeral port chosen by the OS). Ignored when mounted. */
  port?: number;
  /**
   * How the app should reach this host. Standalone default: `http://<lan-ip>:<port>`. Set it for a
   * tunneled host, or **required** in mounted (router/middleware) mode so `.url` can build the QR —
   * include any mount path, e.g. `https://host.example.com/aat`.
   */
  publicUrl?: string;
  /** The device name shown to the app (default the OS hostname). */
  deviceName?: string;
  /** How long the callback stays valid (default 5 min). */
  ttlMs?: number;
}

/**
 * A one-time pairing callback. Choose a surface:
 *
 * ```ts
 * // Standalone (own http server):
 * const s = await new PairingCallbackServer({ port: 8765 }).start();
 * showQr(s.url);
 * const reg = await s.waitForDevice();
 *
 * // Mounted in an existing express app:
 * const s = new PairingCallbackServer({ publicUrl: 'https://host/aat' });
 * app.use('/aat', await s.router());   // or: app.use(s.middleware())
 * showQr(s.url);
 * const reg = await s.waitForDevice();
 * ```
 */
export class PairingCallbackServer {
  private server?: Server;
  readonly nonce = b64url.encode(randomBytes(18));
  readonly deviceName: string;
  private readonly ttlMs: number;
  private readonly wantPort: number;
  private readonly publicUrl?: string;
  private base = '';
  private port = 0;
  private expiresAt = 0;
  private armed = false;
  private used = false;
  private timer?: ReturnType<typeof setTimeout>;
  private resolve?: (r: PairingRegistration) => void;
  private reject?: (e: Error) => void;
  private readonly waiter: Promise<PairingRegistration>;

  constructor(opts: PairingCallbackOptions = {}) {
    this.deviceName = opts.deviceName ?? hostname();
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.wantPort = opts.port ?? 0;
    this.publicUrl = opts.publicUrl;
    this.waiter = new Promise<PairingRegistration>((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
  }

  /** The primary callback URL the app scans/opens (first reachable interface, or the public URL). */
  get url(): string {
    if (!this.base) {
      throw new Error('callback URL not available yet: call start(), or set opts.publicUrl in mounted mode');
    }
    return `${this.base}/pair/${this.nonce}`;
  }

  /**
   * A callback URL per reachable interface (a standalone server binds the wildcard address, so any
   * of them reaches it). When `publicUrl` is set, that single URL is returned. Pick the one the
   * device sees. Only meaningful for a standalone server; in mounted mode set `publicUrl`.
   */
  get urls(): Array<NetIface & { url: string }> {
    if (this.publicUrl) {
      const host = this.publicUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      return [{ name: 'public', address: host, url: `${this.base}/pair/${this.nonce}` }];
    }
    if (!this.port) {
      throw new Error('per-interface URLs need a bound server (call start()); in mounted mode set opts.publicUrl');
    }
    return lanInterfaces().map((i) => ({ ...i, url: `http://${i.address}:${this.port}/pair/${this.nonce}` }));
  }

  /** Arm the nonce lifetime + timeout without binding a server. Idempotent; called by every surface. */
  private arm(): void {
    if (this.armed) return;
    this.armed = true;
    this.expiresAt = Date.now() + this.ttlMs;
    if (this.publicUrl) this.base = this.publicUrl.replace(/\/+$/, '');
    this.timer = setTimeout(() => this.reject?.(new Error('pairing timed out (no device scanned the code)')), this.ttlMs);
    this.timer.unref?.();
  }

  /** Start a **standalone** callback server on its own `http` port. */
  async start(): Promise<this> {
    this.arm();
    this.server = createServer((req, res) => this.handleNode(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.wantPort, () => resolve());
    });
    const addr = this.server!.address();
    this.port = typeof addr === 'object' && addr ? addr.port : this.wantPort;
    if (!this.base) this.base = `http://${primaryLanIp() ?? '127.0.0.1'}:${this.port}`;
    return this;
  }

  /**
   * An Express-compatible middleware for the callback. Mount it however you like:
   * `app.use(server.middleware())` or `app.use('/aat', server.middleware())`. Requests that are not
   * this callback fall through to `next()`, so it composes with the rest of your app.
   *
   * Body handling: if a parser (e.g. `express.json()`) already set `req.body`, that is used;
   * otherwise the raw request stream is read and JSON-parsed.
   */
  middleware(): PairingMiddleware {
    this.arm();
    return (req, res, next): void => {
      const path = req.path ?? req.originalUrl ?? req.url ?? '';
      const readJson = async (): Promise<unknown> => {
        if (req.body !== undefined && req.body !== null && typeof req.body === 'object') return req.body;
        const raw = await readBody(req);
        return raw ? JSON.parse(raw) : {};
      };
      void this.respond(req.method, path, readJson)
        .then((r) => {
          if (!r.matched && next) return next();
          writeJson(res, r.status, r.body);
        })
        .catch((e: unknown) => {
          if (next) return next(e);
          writeJson(res, 500, { error: (e as Error).message });
        });
    };
  }

  /**
   * A ready-to-mount `express.Router` wrapping {@link middleware}. Express is a lazily resolved,
   * **optional** peer dependency: pass your own express (`server.router(express)`) to avoid the
   * dynamic import, or omit it and it will be `import()`ed on demand.
   */
  async router(expressLib?: unknown): Promise<unknown> {
    this.arm();
    // express is an optional peer dependency, resolved at runtime only when router() is used.
    // @ts-ignore — 'express' may be absent at compile time in standalone deployments
    const mod: any = expressLib ?? (await import('express'));
    const express = mod?.default ?? mod;
    const router = express.Router();
    router.use(this.middleware());
    return router;
  }

  /** The registration the app sent (base URL + decrypted token), once it pairs. */
  waitForDevice(): Promise<PairingRegistration> {
    return this.waiter;
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const s = this.server;
    this.server = undefined;
    if (!s) return;
    // Drop lingering keep-alive connections so close() can't block, and never wait forever.
    try {
      (s as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    } catch {
      /* older node without closeAllConnections */
    }
    await Promise.race([new Promise<void>((r) => s.close(() => r())), new Promise<void>((r) => setTimeout(r, 2000))]);
  }

  // --- transport-agnostic core ---

  private matchesPath(rawPath: string): boolean {
    const path = (rawPath || '').split('?')[0];
    const suffix = `/pair/${this.nonce}`;
    return path === suffix || path.endsWith(suffix);
  }

  /**
   * Decide the response for one request, independent of transport. Returns `matched: false` (with a
   * 404 fallback) when the path is not this callback, so middleware can defer to `next()`.
   */
  private async respond(
    method: string | undefined,
    path: string | undefined,
    readJson: () => Promise<unknown>,
  ): Promise<{ matched: boolean; status: number; body: unknown }> {
    if (!this.matchesPath(path ?? '')) return { matched: false, status: 404, body: { error: 'not found' } };
    if (Date.now() > this.expiresAt || this.used) {
      return { matched: true, status: 410, body: { error: 'pairing code expired or already used' } };
    }

    const m = (method ?? 'GET').toUpperCase();
    if (m === 'GET') {
      // The app retrieves WHO it is pairing with (this host's device name).
      return { matched: true, status: 200, body: { deviceName: this.deviceName, nonce: this.nonce, protocol: 'throughaat-pair/1' } };
    }
    if (m === 'POST' || m === 'PUT') {
      try {
        const body = (await readJson()) as { deviceId?: string; url?: string; name?: string };
        if (!body || !body.url) return { matched: true, status: 400, body: { error: 'missing app access url' } };
        const parsed = parseAppAccessUrl(body.url);
        const token = decryptToken(parsed.encToken, this.nonce);
        this.used = true;
        const reg: PairingRegistration = { deviceId: body.deviceId ?? parsed.deviceId, token, baseUrl: parsed.baseUrl, name: body.name };
        this.resolve?.(reg);
        return { matched: true, status: 200, body: { ok: true, deviceName: this.deviceName } };
      } catch (e) {
        return { matched: true, status: 400, body: { error: `registration failed: ${(e as Error).message}` } };
      }
    }
    return { matched: true, status: 405, body: { error: 'method not allowed' } };
  }

  /** Node `http` adapter over {@link respond} (standalone server). */
  private handleNode(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? '').split('?')[0];
    void this.respond(req.method, path, async () => JSON.parse(await readBody(req)))
      .then((r) => writeJson(res, r.status, r.body))
      .catch((e: unknown) => writeJson(res, 500, { error: (e as Error).message }));
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
