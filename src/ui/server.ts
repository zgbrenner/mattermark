/**
 * server.ts — the local web UI server (Slice 4).
 *
 * A thin HTTP surface over the shared Workspace operations layer, for
 * non-technical users. Design constraints:
 *
 *   - node:http and built-ins only; the page (page.ts) is fully inline.
 *   - Binds to 127.0.0.1 by default and NEVER serves a request without the
 *     per-startup random `k` token (crypto.randomBytes) — the URL is the
 *     capability. Wrong or missing token → 403 on every route.
 *   - JSON errors as { error } with proper status codes; error messages come
 *     from the operations layer (already user-actionable) — stack traces are
 *     never sent to the client.
 *   - Request bodies are capped at ~64 MB (base64-encoded documents).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';

import { renderReportMarkdown, type ProtectOptions, type Workspace } from '../workspace.js';
import type { DeliveryMethod } from '../registry.js';
import { PAGE } from './page.js';

export const DEFAULT_PORT = 8787;
export const MAX_BODY_BYTES = 64 * 1024 * 1024; // ~64 MB

const DELIVERY_METHODS: readonly DeliveryMethod[] = [
  'email',
  'secure-link',
  'physical',
  'portal',
  'other',
  'unknown',
];

export interface UiOptions {
  port?: number;
  host?: string;
  open?: boolean;
}

export interface UiHandle {
  url: string;
  close(): Promise<void>;
}

/** An error with a deliberate HTTP status; its message is safe to send. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function startUi(ws: Workspace, opts: UiOptions = {}): Promise<UiHandle> {
  const host = opts.host ?? '127.0.0.1';
  const token = randomBytes(24).toString('base64url');

  const server = createServer((req, res) => {
    void handle(ws, token, req, res).catch((err) => sendError(res, err));
  });
  server.requestTimeout = 0; // large uploads on localhost; no proxy in front

  if (opts.port !== undefined) {
    // Explicit port: use it and fail loudly if it is busy.
    await listenOnce(server, opts.port, host);
  } else {
    // Default port, with a quiet fallback to an ephemeral port.
    try {
      await listenOnce(server, DEFAULT_PORT, host);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        await listenOnce(server, 0, host);
      } else {
        throw err;
      }
    }
  }

  const { port } = server.address() as AddressInfo;
  const url = `http://${host}:${port}/?k=${token}`;

  if (opts.open) openInBrowser(url);

  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/* --------------------------------- routing -------------------------------- */

async function handle(
  ws: Workspace,
  token: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (!tokenOk(url.searchParams.get('k'), token)) {
    throw new HttpError(
      403,
      'missing or invalid access token — reopen the exact URL Mattermark printed at startup',
    );
  }

  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (path === '/') {
    if (method !== 'GET') throw new HttpError(405, 'method not allowed');
    sendHtml(res, PAGE);
    return;
  }

  if (path === '/api/status') {
    requireMethod(method, 'GET');
    sendJson(res, 200, ws.status());
    return;
  }

  if (path === '/api/copies') {
    requireMethod(method, 'GET');
    const copies = [...ws.list()].sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
    sendJson(res, 200, { copies });
    return;
  }

  if (path === '/api/protect') {
    requireMethod(method, 'POST');
    const body = parseJsonBody(await readBody(req));
    sendJson(res, 200, doProtect(ws, body));
    return;
  }

  if (path === '/api/identify') {
    requireMethod(method, 'POST');
    const body = parseJsonBody(await readBody(req));
    sendJson(res, 200, doIdentify(ws, body));
    return;
  }

  if (path === '/api/report') {
    requireMethod(method, 'POST');
    const body = parseJsonBody(await readBody(req));
    const tokenHex = reqString(body, 'token');
    const report = ws.report(tokenHex);
    sendJson(res, 200, { markdown: renderReportMarkdown(report), report });
    return;
  }

  throw new HttpError(404, `no such endpoint: ${method} ${path}`);
}

/* -------------------------------- handlers -------------------------------- */

function doProtect(ws: Workspace, body: Record<string, unknown>): unknown {
  const name = reqString(body, 'name');
  const dataBase64 = reqString(body, 'dataBase64');
  const matter = reqString(body, 'matter');
  const recipient = reqString(body, 'recipient');
  const version = optString(body, 'version');
  const delivery = optString(body, 'delivery');
  const note = optString(body, 'note');
  const by = optString(body, 'by');
  const searchSafe = optBoolean(body, 'searchSafe');

  if (delivery !== undefined && !DELIVERY_METHODS.includes(delivery as DeliveryMethod)) {
    throw new HttpError(400, `delivery must be one of: ${DELIVERY_METHODS.join(', ')}`);
  }

  const protectOpts: ProtectOptions = {
    matter,
    recipient,
    version,
    deliveryMethod: delivery as DeliveryMethod | undefined,
    deliveryNote: note,
    generatedBy: by,
    searchSafe,
  };
  const out = ws.protect({ name, bytes: Buffer.from(dataBase64, 'base64') }, protectOpts);

  const survived = out.transformTests.filter((t) => t.recovered).length;
  return {
    suggestedName: out.suggestedName,
    dataBase64: out.bytes.toString('base64'),
    format: out.format,
    durable: out.result.durable,
    survivalRate: out.transformTests.length ? survived / out.transformTests.length : 0,
    warnings: out.result.warnings,
    layers: out.result.layers,
    tokenHex: out.result.tokenHex,
    copy: out.copy,
  };
}

function doIdentify(ws: Workspace, body: Record<string, unknown>): unknown {
  const name = reqString(body, 'name');
  const dataBase64 = reqString(body, 'dataBase64');
  const record = optBoolean(body, 'record');
  const by = optString(body, 'by');
  const source = optString(body, 'source');

  return ws.identify(
    { name, bytes: Buffer.from(dataBase64, 'base64') },
    { record, actor: by, sourceDescription: source },
  );
}

/* ------------------------------ body handling ------------------------------ */

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'request body exceeds the 64 MB limit'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

function parseJsonBody(raw: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function reqString(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new HttpError(400, `field "${key}" is required and must be a non-empty string`);
  }
  return v;
}

function optString(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new HttpError(400, `field "${key}" must be a string`);
  return v;
}

function optBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new HttpError(400, `field "${key}" must be a boolean`);
  return v;
}

/* -------------------------------- responses -------------------------------- */

const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
} as const;

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...BASE_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res: ServerResponse, html: string): void {
  if (res.writableEnded) return;
  res.writeHead(200, {
    ...BASE_HEADERS,
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
      "connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'",
  });
  res.end(html);
}

/**
 * Convert an error into a JSON response without ever leaking a stack trace.
 * Plain Errors from the operations layer are operational (e.g. "PDF marking
 * is not supported…") and carry user-actionable messages → 400.
 */
function sendError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err instanceof HttpError) {
    sendJson(res, err.status, { error: err.message });
  } else if (err instanceof Error) {
    sendJson(res, 400, { error: err.message });
  } else {
    sendJson(res, 500, { error: 'internal error' });
  }
}

function requireMethod(method: string, expected: string): void {
  if (method !== expected) throw new HttpError(405, `method not allowed (use ${expected})`);
}

/* --------------------------------- helpers --------------------------------- */

function tokenOk(candidate: string | null, token: string): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(token, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function listenOnce(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/** Best-effort browser launch; never throws, never fails startup. */
function openInBrowser(url: string): void {
  try {
    const cmd =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      /* browser open is best-effort */
    });
    child.unref();
  } catch {
    /* best-effort only */
  }
}
