import { createHash, generateKeyPairSync, randomBytes } from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { createHttpTransport, loadHttpOptions } from '../src/http/server.js';
import { OAuthProvider } from '../src/oauth/provider.js';
import { InMemoryOAuthStore } from '../src/oauth/store.js';
import { InMemoryTenantStore } from '../src/tenants/store.js';
import { mockHttp } from './mocks/http.mock.js';

const { privateKey: keyObject } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKey = keyObject.export({ type: 'pkcs8', format: 'pem' }).toString();
const certificate = '-----BEGIN CERTIFICATE-----\nMIIBtest\n-----END CERTIFICATE-----';

const REVOLUT_OK = {
  'POST /auth/token': {
    data: {
      access_token: 'oa_access',
      refresh_token: 'oa_refresh',
      token_type: 'bearer',
      expires_in: 2400,
      scope: 'READ',
    },
  },
  'GET /accounts': {
    data: [{ id: 'acc-1', name: 'Acme SRL EUR', balance: 100, currency: 'EUR', state: 'active' }],
  },
};

const BASE = 'https://revolut-mcp.test';

interface Harness {
  server: Server;
  origin: string;
  tenants: InMemoryTenantStore;
  provider: OAuthProvider;
  close: () => Promise<void>;
}

async function start(hosted = true): Promise<Harness> {
  const tenants = new InMemoryTenantStore();
  const { http } = mockHttp(REVOLUT_OK);
  const provider = new OAuthProvider(
    new InMemoryOAuthStore(),
    tenants,
    { privateKey, certificate, redirectUri: `${BASE}/revolut/callback` },
    Date.now,
    http
  );

  const server = createHttpTransport(
    { port: 0, host: '127.0.0.1', path: '/mcp', publicBaseUrl: BASE, allowedHosts: [] },
    hosted ? { oauth: provider, tenants } : undefined
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    server,
    origin: `http://127.0.0.1:${port}`,
    tenants,
    provider,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Registers a client and returns everything needed to drive /authorize. */
async function registerClient(origin: string) {
  const response = await fetch(`${origin}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: ['https://client.example.com/cb'],
      client_name: 'Test Client',
    }),
  });
  const info = (await response.json()) as { client_id: string };
  const verifier = randomBytes(32).toString('base64url');
  return {
    clientId: info.client_id,
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    status: response.status,
  };
}

describe('HTTP transport', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await start();
  });
  afterAll(() => harness.close());

  it('reports health, including whether hosted mode came up', async () => {
    const response = await fetch(`${harness.origin}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'ok', hosted: true });
  });

  it('publishes discovery metadata pointing at the public origin', async () => {
    const as = await fetch(`${harness.origin}/.well-known/oauth-authorization-server`);
    expect(as.status).toBe(200);
    const meta = (await as.json()) as Record<string, string>;
    expect(meta.issuer).toBe(BASE);
    expect(meta.authorization_endpoint).toBe(`${BASE}/authorize`);
    expect(meta.token_endpoint).toBe(`${BASE}/token`);
    expect(meta.registration_endpoint).toBe(`${BASE}/register`);
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);

    const prm = await fetch(`${harness.origin}/.well-known/oauth-protected-resource/mcp`);
    expect(prm.status).toBe(200);
    await expect(prm.json()).resolves.toMatchObject({
      resource: `${BASE}/mcp`,
      authorization_servers: [BASE],
    });
  });

  it('serves the certificate businesses have to register', async () => {
    const response = await fetch(`${harness.origin}/certificate.pem`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('pem');
    await expect(response.text()).resolves.toContain('BEGIN CERTIFICATE');
  });

  it('challenges an unauthenticated MCP request and names the resource metadata', async () => {
    const response = await fetch(`${harness.origin}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`
    );
  });

  it('rejects a bearer token it never issued', async () => {
    const response = await fetch(`${harness.origin}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer not-a-real-token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(response.status).toBe(401);
  });

  it('renders the connect page with both values the business must paste', async () => {
    const { clientId, challenge } = await registerClient(harness.origin);
    const url = new URL(`${harness.origin}/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', 'https://client.example.com/cb');
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');

    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('BEGIN CERTIFICATE');
    expect(html).toContain(`${BASE}/revolut/callback`);
    expect(html).toContain('Test Client');
    // The OAuth request has to survive the POST or the flow cannot resume.
    expect(html).toContain(`value="${challenge}"`);
  });

  it('refuses to render the connect page for an unregistered client', async () => {
    const url = new URL(`${harness.origin}/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', 'made-up');
    url.searchParams.set('redirect_uri', 'https://evil.example.com/cb');
    url.searchParams.set('code_challenge', 'x');
    url.searchParams.set('code_challenge_method', 'S256');
    const response = await fetch(url);
    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain('start the connection');
  });

  describe('the full connect round-trip', () => {
    it('walks register → authorize → Revolut → token → authenticated MCP call', async () => {
      const { clientId, verifier, challenge } = await registerClient(harness.origin);

      // 1. The business submits its Revolut client id.
      const submit = await fetch(`${harness.origin}/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        redirect: 'manual',
        body: new URLSearchParams({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: 'https://client.example.com/cb',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state: 'client-state',
          revolut_client_id: 'rev-client-abc',
          environment: 'production',
        }),
      });
      expect(submit.status).toBe(302);

      // 2. We hand the browser to Revolut, and remember the attempt in a cookie.
      const revolut = new URL(submit.headers.get('location')!);
      expect(revolut.origin).toBe('https://business.revolut.com');
      const linkId = revolut.searchParams.get('state')!;
      expect(linkId).toBeTruthy();
      const cookie = submit.headers.get('set-cookie')!;
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');

      // 3. Revolut sends the browser back with its code.
      const callback = await fetch(
        `${harness.origin}/revolut/callback?code=oa_prod_code&state=${encodeURIComponent(linkId)}`,
        { redirect: 'manual' }
      );
      expect(callback.status).toBe(302);
      const back = new URL(callback.headers.get('location')!);
      expect(back.origin + back.pathname).toBe('https://client.example.com/cb');
      expect(back.searchParams.get('state')).toBe('client-state');
      const authCode = back.searchParams.get('code')!;
      expect(authCode).toBeTruthy();

      // The business is now stored, with its Revolut tokens.
      const tenant = await harness.tenants.get('rev-client-abc');
      expect(tenant?.environment).toBe('production');
      expect(tenant?.label).toBe('Acme SRL EUR');

      // 4. The MCP client redeems the code.
      const tokenResponse = await fetch(`${harness.origin}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: authCode,
          code_verifier: verifier,
          redirect_uri: 'https://client.example.com/cb',
          client_id: clientId,
        }),
      });
      expect(tokenResponse.status).toBe(200);
      const tokens = (await tokenResponse.json()) as { access_token: string; refresh_token: string };
      expect(tokens.access_token).toBeTruthy();

      // 5. That token now works against the MCP endpoint.
      const mcp = await fetch(`${harness.origin}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${tokens.access_token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test', version: '1' },
          },
        }),
      });
      expect(mcp.status).toBe(200);
      const body = await mcp.text();
      expect(body).toContain('revolut-mcp');

      // 6. Revoking it cuts the connection without touching Revolut.
      await fetch(`${harness.origin}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: tokens.access_token }),
      });
      const afterRevoke = await fetch(`${harness.origin}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${tokens.access_token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }),
      });
      expect(afterRevoke.status).toBe(401);
    });

    it('falls back to the cookie when Revolut does not echo state', async () => {
      const { clientId, challenge } = await registerClient(harness.origin);
      const submit = await fetch(`${harness.origin}/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        redirect: 'manual',
        body: new URLSearchParams({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: 'https://client.example.com/cb',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          revolut_client_id: 'rev-client-cookie',
          environment: 'sandbox',
        }),
      });
      const cookie = submit.headers.get('set-cookie')!.split(';')[0];

      const callback = await fetch(`${harness.origin}/revolut/callback?code=oa_code`, {
        redirect: 'manual',
        headers: { Cookie: cookie },
      });
      expect(callback.status).toBe(302);
      expect(await harness.tenants.get('rev-client-cookie')).not.toBeNull();
    });

    it('re-shows the form, keeping what was typed, when the client id is malformed', async () => {
      const { clientId, challenge } = await registerClient(harness.origin);
      const submit = await fetch(`${harness.origin}/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        redirect: 'manual',
        body: new URLSearchParams({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: 'https://client.example.com/cb',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          revolut_client_id: 'not a client id',
          environment: 'sandbox',
        }),
      });
      expect(submit.status).toBe(400);
      const html = await submit.text();
      expect(html).toContain('look like a Revolut Client ID');
      expect(html).toContain('value="not a client id"');
      // Sandbox stays selected, so the retry does not silently switch environment.
      expect(html).toMatch(/value="sandbox"\s+checked/);
    });

    it('explains a refusal that comes back on the redirect', async () => {
      const response = await fetch(
        `${harness.origin}/revolut/callback?error=access_denied&error_description=User+declined`,
        { redirect: 'manual' }
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain('Revolut did not approve');
      expect(html).toContain('User declined');
    });

    it('rejects a callback with no code and no link', async () => {
      const response = await fetch(`${harness.origin}/revolut/callback`, { redirect: 'manual' });
      expect(response.status).toBe(400);
      await expect(response.text()).resolves.toContain('finish connecting');
    });
  });

  it('404s an unknown path and 405s a known one with the wrong method', async () => {
    expect((await fetch(`${harness.origin}/nope`)).status).toBe(404);
    expect((await fetch(`${harness.origin}/token`)).status).toBe(405);
  });

  it('answers the root with a service descriptor, not HTML', async () => {
    const response = await fetch(`${harness.origin}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toMatchObject({ name: 'revolut-mcp', endpoint: '/mcp' });
  });
});

describe('HTTP transport without hosted mode', () => {
  it('still serves health but refuses MCP requests with a diagnosable error', async () => {
    const harness = await start(false);
    try {
      await expect((await fetch(`${harness.origin}/health`)).json()).resolves.toMatchObject({
        hosted: false,
      });
      const response = await fetch(`${harness.origin}/mcp`, { method: 'POST' });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ error: 'oauth_unavailable' });
    } finally {
      await harness.close();
    }
  });
});

describe('loadHttpOptions', () => {
  it('defaults to port 80, /mcp and a dual-stack bind', () => {
    const options = loadHttpOptions({} as NodeJS.ProcessEnv);
    expect(options).toMatchObject({ port: 80, path: '/mcp', host: '::' });
    expect(options.publicBaseUrl).toBeUndefined();
  });

  it('normalises the public base URL and the MCP path', () => {
    const options = loadHttpOptions({
      PORT: '8080',
      MCP_PATH: '/api/mcp/',
      PUBLIC_BASE_URL: 'https://example.com/',
    } as NodeJS.ProcessEnv);
    expect(options.port).toBe(8080);
    expect(options.path).toBe('/api/mcp');
    expect(options.publicBaseUrl).toBe('https://example.com');
  });

  it('rejects nonsense rather than starting on a wrong address', () => {
    expect(() => loadHttpOptions({ PORT: 'abc' } as NodeJS.ProcessEnv)).toThrow(/PORT/);
    expect(() => loadHttpOptions({ MCP_PATH: 'mcp' } as NodeJS.ProcessEnv)).toThrow(/slash/);
    expect(() => loadHttpOptions({ PUBLIC_BASE_URL: 'example.com' } as NodeJS.ProcessEnv)).toThrow(
      /absolute URL/
    );
  });
});
