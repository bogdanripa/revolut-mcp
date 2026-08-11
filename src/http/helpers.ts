// Small shared helpers for the raw node:http layer, factored out so both the
// main transport (server.ts) and the OAuth router (oauth/routes.ts) can use them
// without a circular import.

import type { IncomingMessage, ServerResponse } from 'http';

/** Reads a request body, capped so a huge POST can't exhaust memory. */
export async function readBody(req: IncomingMessage, limitBytes = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > limitBytes) throw new Error('Request body too large.');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string | string[]> = {}
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

export function sendHtml(
  res: ServerResponse,
  status: number,
  html: string,
  headers: Record<string, string | string[]> = {}
): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(html);
}

export function sendText(
  res: ServerResponse,
  status: number,
  text: string,
  contentType = 'text/plain; charset=utf-8'
): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

export function redirect(res: ServerResponse, location: string, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...headers });
  res.end();
}

/** Reads one cookie off the request, or undefined. */
export function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/**
 * SameSite=Lax is the point of this cookie: it survives the top-level
 * navigation back from Revolut, which is exactly the hop we need it for, and
 * nothing else.
 */
export function setCookie(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie(name: string, secure: boolean): string {
  return setCookie(name, '', 0, secure);
}

/** Permissive CORS for the OAuth discovery/registration/token endpoints. */
export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Protocol-Version',
  'Access-Control-Max-Age': '86400',
};
