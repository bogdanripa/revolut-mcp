import { createHash, generateKeyPairSync, randomBytes } from 'crypto';
import { OAuthError, OAuthProvider, RevolutLinkError } from '../src/oauth/provider.js';
import { InMemoryOAuthStore } from '../src/oauth/store.js';
import { InMemoryTenantStore } from '../src/tenants/store.js';
import { CannedResponse, mockHttp } from './mocks/http.mock.js';

const { privateKey, certificate } = (() => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    // The provider never parses this; it only hands it to the browser.
    certificate: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
  };
})();

const CALLBACK = 'https://revolut-mcp.example.com/revolut/callback';

function verifier(): { verifier: string; challenge: string } {
  const value = randomBytes(32).toString('base64url');
  return { verifier: value, challenge: createHash('sha256').update(value).digest('base64url') };
}

/** The two upstream calls a successful link makes. */
const REVOLUT_OK: Record<string, CannedResponse> = {
  'POST /auth/token': {
    data: {
      access_token: 'oa_sand_access',
      refresh_token: 'oa_sand_refresh',
      token_type: 'bearer',
      expires_in: 2400,
      scope: 'READ',
    },
  },
  'GET /accounts': {
    data: [{ id: 'acc-1', name: 'Main EUR', balance: 10, currency: 'EUR', state: 'active' }],
  },
};

function build(routes: Record<string, CannedResponse> = REVOLUT_OK, now?: () => number) {
  const store = new InMemoryOAuthStore();
  const tenants = new InMemoryTenantStore();
  const { http, requests } = mockHttp(routes);
  const provider = new OAuthProvider(
    store,
    tenants,
    { privateKey, certificate, redirectUri: CALLBACK },
    now ?? Date.now,
    http
  );
  return { store, tenants, provider, requests };
}

async function registerAndAuthorize(provider: OAuthProvider) {
  const client = await provider.registerClient({
    redirect_uris: ['https://client.example.com/cb'],
    client_name: 'Test Client',
  });
  const pkce = verifier();
  const request = {
    clientId: client.client_id,
    redirectUri: 'https://client.example.com/cb',
    codeChallenge: pkce.challenge,
    codeChallengeMethod: 'S256',
    responseType: 'code',
    state: 'client-state',
  };
  return { client, pkce, request };
}

describe('OAuthProvider', () => {

  describe('client registration', () => {
    it('issues a public client with no secret', async () => {
      const { provider } = build();
      const info = await provider.registerClient({
        redirect_uris: ['https://client.example.com/cb'],
        client_name: 'Claude',
      });
      expect(info.client_id).toBeTruthy();
      expect(info).not.toHaveProperty('client_secret');
      expect(info.token_endpoint_auth_method).toBe('none');
      expect(info.grant_types).toEqual(['authorization_code', 'refresh_token']);
    });

    it('accepts a native client scheme but rejects javascript: and missing URIs', async () => {
      const { provider } = build();
      await expect(provider.registerClient({ redirect_uris: ['cursor://cb'] })).resolves.toBeTruthy();
      await expect(provider.registerClient({ redirect_uris: [] })).rejects.toThrow(OAuthError);
      await expect(
        provider.registerClient({ redirect_uris: ['javascript:alert(1)'] })
      ).rejects.toThrow(OAuthError);
      await expect(provider.registerClient({ redirect_uris: ['http://evil.com/cb'] })).rejects.toThrow(
        OAuthError
      );
    });
  });

  describe('authorize validation', () => {
    it('rejects an unknown client, a foreign redirect_uri and a missing PKCE challenge', async () => {
      const { provider } = build();
      const { request } = await registerAndAuthorize(provider);

      await expect(
        provider.validateAuthorizeRequest({ ...request, clientId: 'nope' })
      ).rejects.toThrow(/Unknown client_id/);
      await expect(
        provider.validateAuthorizeRequest({ ...request, redirectUri: 'https://evil.example.com/cb' })
      ).rejects.toThrow(/redirect_uri/);
      await expect(
        provider.validateAuthorizeRequest({ ...request, codeChallenge: '' })
      ).rejects.toThrow(/PKCE/);
      await expect(
        provider.validateAuthorizeRequest({ ...request, codeChallengeMethod: 'plain' })
      ).rejects.toThrow(/PKCE/);
      await expect(
        provider.validateAuthorizeRequest({ ...request, responseType: 'token' })
      ).rejects.toThrow(/response_type/);
    });
  });

  describe('beginLink', () => {
    it('sends the browser to the right Revolut portal, carrying the link id as state', async () => {
      const { provider } = build();
      const { request } = await registerAndAuthorize(provider);

      const sandbox = await provider.beginLink(request, {
        revolutClientId: 'rev-client-123',
        environment: 'sandbox',
      });
      const url = new URL(sandbox.authorizationUrl);
      expect(url.origin).toBe('https://sandbox-business.revolut.com');
      expect(url.pathname).toBe('/app-confirm');
      expect(url.searchParams.get('client_id')).toBe('rev-client-123');
      expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('state')).toBe(sandbox.linkId);

      const production = await provider.beginLink(request, {
        revolutClientId: 'rev-client-123',
        environment: 'production',
      });
      expect(new URL(production.authorizationUrl).origin).toBe('https://business.revolut.com');
    });

    it('rejects a client id that cannot be one, before any redirect happens', async () => {
      const { provider } = build();
      const { request } = await registerAndAuthorize(provider);
      await expect(
        provider.beginLink(request, { revolutClientId: 'has spaces', environment: 'production' })
      ).rejects.toThrow(RevolutLinkError);
      await expect(
        provider.beginLink(request, { revolutClientId: '', environment: 'production' })
      ).rejects.toThrow(RevolutLinkError);
    });

    it('stores nothing against the business until consent actually happens', async () => {
      const { provider, tenants } = build();
      const { request } = await registerAndAuthorize(provider);
      await provider.beginLink(request, { revolutClientId: 'rev-client-123', environment: 'sandbox' });
      expect(await tenants.count()).toBe(0);
    });
  });

  describe('completeLink', () => {
    it('exchanges the code, stores the business, and redirects back with our own code', async () => {
      const { provider, tenants } = build();
      const { request } = await registerAndAuthorize(provider);
      const { linkId } = await provider.beginLink(request, {
        revolutClientId: 'rev-client-123',
        environment: 'sandbox',
      });

      const { redirectTo, label } = await provider.completeLink(linkId, 'oa_sand_authcode');

      const location = new URL(redirectTo);
      expect(location.origin + location.pathname).toBe('https://client.example.com/cb');
      expect(location.searchParams.get('code')).toBeTruthy();
      expect(location.searchParams.get('state')).toBe('client-state');

      expect(label).toBe('Main EUR');
      const tenant = await tenants.get('rev-client-123');
      expect(tenant?.environment).toBe('sandbox');
      expect(tenant?.tokens.accessToken).toBe('oa_sand_access');
      expect(tenant?.tokens.refreshToken).toBe('oa_sand_refresh');
    });

    it('uses the production endpoint for a production link', async () => {
      const { provider, tenants, requests } = build();
      const { request } = await registerAndAuthorize(provider);
      const { linkId } = await provider.beginLink(request, {
        revolutClientId: 'rev-prod-1',
        environment: 'production',
      });

      await provider.completeLink(linkId, 'code');
      expect((await tenants.get('rev-prod-1'))?.environment).toBe('production');
      expect(requests[0].url).toBe('https://b2b.revolut.com/api/1.0/auth/token');
    });

    it('is single-use — a replayed link id fails', async () => {
      const { provider } = build();
      const { request } = await registerAndAuthorize(provider);
      const { linkId } = await provider.beginLink(request, {
        revolutClientId: 'rev-client-123',
        environment: 'sandbox',
      });

      await provider.completeLink(linkId, 'code');
      await expect(provider.completeLink(linkId, 'code')).rejects.toThrow(RevolutLinkError);
    });

    it('explains a refusal from Revolut instead of leaking the axios error', async () => {
      const { provider, tenants } = build({ 'POST /auth/token': { status: 401, data: { error: 'invalid_client' } } });
      const { request } = await registerAndAuthorize(provider);
      const { linkId } = await provider.beginLink(request, {
        revolutClientId: 'rev-client-123',
        environment: 'sandbox',
      });

      const error = await provider.completeLink(linkId, 'stale-code').catch((e) => e);
      expect(error).toBeInstanceOf(RevolutLinkError);
      expect(error.hint).toMatch(/redirect URI|certificate/i);
      expect(await tenants.count()).toBe(0);
    });

    it('refuses to report success when the consent granted no read access', async () => {
      const { provider, tenants } = build({
        'POST /auth/token': {
          data: { access_token: 'a', refresh_token: 'r', token_type: 'bearer', expires_in: 2400 },
        },
        'GET /accounts': { status: 403, data: { message: 'forbidden' } },
      });
      const { request } = await registerAndAuthorize(provider);
      const { linkId } = await provider.beginLink(request, {
        revolutClientId: 'rev-client-123',
        environment: 'sandbox',
      });

      const error = await provider.completeLink(linkId, 'code').catch((e) => e);
      expect(error).toBeInstanceOf(RevolutLinkError);
      expect(error.hint).toMatch(/Read your account details/);
      // Nothing half-connected is left behind.
      expect(await tenants.count()).toBe(0);
    });
  });

  describe('token grants', () => {
    async function connected() {
      const built = build();
      const { request, pkce } = await registerAndAuthorize(built.provider);
      const { linkId } = await built.provider.beginLink(request, {
        revolutClientId: 'rev-client-123',
        environment: 'sandbox',
      });
      const { redirectTo } = await built.provider.completeLink(linkId, 'code');
      const code = new URL(redirectTo).searchParams.get('code')!;
      return { ...built, request, pkce, code };
    }

    it('issues tokens for a valid code + verifier', async () => {
      const { provider, request, pkce, code } = await connected();
      const tokens = await provider.exchangeCode({
        code,
        codeVerifier: pkce.verifier,
        redirectUri: request.redirectUri,
        clientId: request.clientId,
      });
      expect(tokens.token_type).toBe('Bearer');
      expect(tokens.access_token).toBeTruthy();
      expect(tokens.refresh_token).toBeTruthy();
      expect(tokens.expires_in).toBeGreaterThan(0);
    });

    it('rejects a wrong verifier, a mismatched redirect_uri, and a replayed code', async () => {
      const { provider, request, pkce, code } = await connected();

      await expect(
        provider.exchangeCode({
          code,
          codeVerifier: 'wrong',
          redirectUri: request.redirectUri,
          clientId: request.clientId,
        })
      ).rejects.toThrow(/PKCE/);

      // The failed attempt consumed the single-use code, so start over.
      const second = await connected();
      await expect(
        second.provider.exchangeCode({
          code: second.code,
          codeVerifier: second.pkce.verifier,
          redirectUri: 'https://evil.example.com/cb',
          clientId: second.request.clientId,
        })
      ).rejects.toThrow(/redirect_uri/);

      const third = await connected();
      await third.provider.exchangeCode({
        code: third.code,
        codeVerifier: third.pkce.verifier,
        redirectUri: third.request.redirectUri,
      });
      await expect(
        third.provider.exchangeCode({
          code: third.code,
          codeVerifier: third.pkce.verifier,
          redirectUri: third.request.redirectUri,
        })
      ).rejects.toThrow(/already used/);

      expect(pkce.verifier).toBeTruthy();
    });

    it('resolves a bearer token back to the business, and stops once revoked', async () => {
      const { provider, request, pkce, code } = await connected();
      const tokens = await provider.exchangeCode({
        code,
        codeVerifier: pkce.verifier,
        redirectUri: request.redirectUri,
      });

      const tenant = await provider.verifyBearer(tokens.access_token);
      expect(tenant.clientId).toBe('rev-client-123');
      expect(tenant.tokens.accessToken).toBe('oa_sand_access');

      await provider.revoke(tokens.access_token);
      await expect(provider.verifyBearer(tokens.access_token)).rejects.toThrow(OAuthError);
    });

    it('refuses a refresh token presented as a bearer token', async () => {
      const { provider, request, pkce, code } = await connected();
      const tokens = await provider.exchangeCode({
        code,
        codeVerifier: pkce.verifier,
        redirectUri: request.redirectUri,
      });
      await expect(provider.verifyBearer(tokens.refresh_token!)).rejects.toThrow(/Invalid access token/);
    });

    it('refreshes into a new access token, keeping the same refresh token', async () => {
      const { provider, request, pkce, code } = await connected();
      const first = await provider.exchangeCode({
        code,
        codeVerifier: pkce.verifier,
        redirectUri: request.redirectUri,
      });
      const second = await provider.exchangeRefreshToken({ refreshToken: first.refresh_token! });
      expect(second.access_token).not.toBe(first.access_token);
      expect(second.refresh_token).toBe(first.refresh_token);
      await expect(provider.verifyBearer(second.access_token)).resolves.toBeTruthy();
    });

    it('rejects an expired access token', async () => {
      let now = Date.now();
      const { provider } = build(REVOLUT_OK, () => now);
      const { request, pkce } = await registerAndAuthorize(provider);
      const { linkId } = await provider.beginLink(request, {
        revolutClientId: 'rev-client-123',
        environment: 'sandbox',
      });
      const { redirectTo } = await provider.completeLink(linkId, 'code');
      const tokens = await provider.exchangeCode({
        code: new URL(redirectTo).searchParams.get('code')!,
        codeVerifier: pkce.verifier,
        redirectUri: request.redirectUri,
      });

      now += 2 * 60 * 60 * 1000; // past the 1-hour access token TTL
      await expect(provider.verifyBearer(tokens.access_token)).rejects.toThrow(/expired/);
    });
  });

  it('never stores a raw code or token — only its hash', async () => {
    const { provider, store } = build();
    const { request, pkce } = await registerAndAuthorize(provider);
    const { linkId } = await provider.beginLink(request, {
      revolutClientId: 'rev-client-123',
      environment: 'sandbox',
    });
    const { redirectTo } = await provider.completeLink(linkId, 'code');
    const authCode = new URL(redirectTo).searchParams.get('code')!;

    // The raw code is not a key in the store; its SHA-256 is.
    expect(await store.takeCode(authCode)).toBeNull();
    const hashed = createHash('sha256').update(authCode).digest('hex');
    expect(await store.takeCode(hashed)).not.toBeNull();
    expect(pkce.verifier).toBeTruthy();
  });
});
