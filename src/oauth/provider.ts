// The OAuth 2.1 authorization-server logic we present to MCP clients: Dynamic
// Client Registration, the authorization-code + PKCE flow, token
// issuance/refresh, bearer verification and revocation. Transport-agnostic —
// routes.ts adapts raw HTTP to this.
//
// The twist versus a textbook AS is the middle of the flow. Instead of showing a
// password form, /authorize collects the business's Revolut `client_id` and
// hands the browser off to Revolut's own consent screen. Revolut redirects back
// to /revolut/callback, we exchange that code for the business's tokens using
// the deployment's signing key, store them, and only then mint the
// authorization code the MCP client is waiting for. The MCP client therefore
// never sees a Revolut token — just a bearer token that maps to the tenant.

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { AxiosInstance } from 'axios';
import { buildTenantConfig, Environment } from '../config.js';
import { RevolutAuth } from '../client/auth.js';
import { RevolutClient } from '../client/revolut-client.js';
import { MemoryTokenSource } from '../client/token-source.js';
import { StoredTokens } from '../types/revolut.js';
import { TenantStore, Tenant } from '../tenants/store.js';
import { OAuthStore, StoredClient } from './store.js';

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const LINK_TTL_MS = 30 * 60 * 1000; // 30 minutes at Revolut's consent screen
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days, matching Revolut's consent window

/** An OAuth error carrying the RFC 6749 error code and the HTTP status to send. */
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

/** Revolut refused the authorization code — shown back on the connect page. */
export class RevolutLinkError extends Error {
  constructor(
    message: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = 'RevolutLinkError';
  }
}

export interface ClientMetadata {
  redirect_uris?: unknown;
  client_name?: unknown;
  grant_types?: unknown;
  token_endpoint_auth_method?: unknown;
}

export interface ClientInformation {
  client_id: string;
  client_id_issued_at: number;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  grant_types: string[];
  response_types: string[];
  client_name?: string;
}

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  responseType: string;
  state?: string;
  resource?: string;
  scope?: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

/** What the deployment itself holds: the one keypair every business registers. */
export interface ServiceIdentity {
  /** PEM private key that signs the client-assertion JWT. */
  privateKey: string;
  /** PEM X.509 certificate the businesses paste into their Revolut portal. */
  certificate: string;
  /** The redirect URI every business registers, e.g. https://host/revolut/callback. */
  redirectUri: string;
}

function base64UrlSha256(input: string): string {
  return createHash('sha256').update(input).digest('base64url');
}
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant-time comparison of two equal-purpose strings. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** A redirect URI must be an absolute https URL, http on loopback, or a private-use scheme. */
function isAllowedRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  // Native MCP clients register a custom scheme, e.g. `cursor://` or `vscode://`.
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && url.protocol !== 'javascript:';
}

/**
 * Revolut client ids are opaque, but they are always a compact token — checking
 * the shape here turns a typo into an immediate, readable error on the connect
 * page instead of a confusing failure after the Revolut round-trip.
 */
export function looksLikeRevolutClientId(value: string): boolean {
  return /^[A-Za-z0-9._~-]{8,128}$/.test(value.trim());
}

/**
 * Accepts either a bare Client ID or the Revolut page URL it appears in.
 *
 * The ID is genuinely hard to find: it is not shown when the certificate is
 * created, only in a side panel after clicking the certificate in the list. But
 * clicking it also puts `clientId` in the address bar, and copying the URL is
 * something anyone can do without being told where to look. So take both, and
 * let the address bar be the easy path.
 */
export function extractRevolutClientId(value: string): string {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;
  try {
    const fromQuery = new URL(trimmed).searchParams.get('clientId');
    return fromQuery?.trim() || trimmed;
  } catch {
    return trimmed;
  }
}

export class OAuthProvider {
  constructor(
    private readonly store: OAuthStore,
    private readonly tenants: TenantStore,
    private readonly service: ServiceIdentity,
    private readonly now: () => number = Date.now,
    /** Injected in tests so the Revolut round-trip can be exercised without a network. */
    private readonly http?: AxiosInstance
  ) {}

  get certificate(): string {
    return this.service.certificate;
  }

  get callbackUri(): string {
    return this.service.redirectUri;
  }

  /** Dynamic Client Registration (RFC 7591). Public clients only — no secret issued. */
  async registerClient(metadata: ClientMetadata): Promise<ClientInformation> {
    const redirectUris = Array.isArray(metadata.redirect_uris) ? metadata.redirect_uris : [];
    if (
      redirectUris.length === 0 ||
      !redirectUris.every((u) => typeof u === 'string' && isAllowedRedirectUri(u))
    ) {
      throw new OAuthError(
        'invalid_client_metadata',
        'redirect_uris must be one or more absolute https URLs.'
      );
    }
    const grantTypes =
      Array.isArray(metadata.grant_types) && metadata.grant_types.length > 0
        ? (metadata.grant_types as string[])
        : ['authorization_code', 'refresh_token'];
    const clientName = typeof metadata.client_name === 'string' ? metadata.client_name : undefined;

    const client: StoredClient = {
      clientId: randomToken(),
      clientName,
      redirectUris: redirectUris as string[],
      tokenEndpointAuthMethod: 'none',
      grantTypes,
      createdAt: this.now(),
    };
    await this.store.saveClient(client);

    return {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(client.createdAt / 1000),
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: client.grantTypes,
      response_types: ['code'],
      client_name: clientName,
    };
  }

  /**
   * Validates an /authorize request before anything is shown to the user, so an
   * unregistered client or redirect_uri never receives a code or a redirect.
   */
  async validateAuthorizeRequest(req: AuthorizeRequest): Promise<StoredClient> {
    const client = await this.store.getClient(req.clientId);
    if (!client) throw new OAuthError('invalid_client', 'Unknown client_id.');
    if (!client.redirectUris.includes(req.redirectUri)) {
      throw new OAuthError('invalid_request', 'redirect_uri does not match a registered value.');
    }
    if (req.responseType !== 'code') {
      throw new OAuthError('unsupported_response_type', 'Only response_type=code is supported.');
    }
    if (!req.codeChallenge || req.codeChallengeMethod !== 'S256') {
      throw new OAuthError('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
    }
    return client;
  }

  /**
   * Called when the business submits its Revolut client_id on the connect page.
   * Parks the MCP client's request and returns the Revolut consent URL to send
   * the browser to. Nothing is stored against the business yet — consent has not
   * happened.
   */
  async beginLink(
    req: AuthorizeRequest,
    input: { revolutClientId: string; environment: Environment }
  ): Promise<{ linkId: string; authorizationUrl: string }> {
    await this.validateAuthorizeRequest(req);

    const revolutClientId = extractRevolutClientId(input.revolutClientId);
    if (!looksLikeRevolutClientId(revolutClientId)) {
      throw new RevolutLinkError(
        "That doesn't look like a Revolut Client ID.",
        'In Revolut → Settings → APIs, click the certificate you created: the ClientID appears in ' +
          'the panel on the right, with a Copy button. You can also just paste this whole page URL ' +
          'from your browser — the ID is in it and we will pick it out.'
      );
    }

    const linkId = randomToken();
    await this.store.saveLink(linkId, {
      clientId: req.clientId,
      redirectUri: req.redirectUri,
      codeChallenge: req.codeChallenge,
      state: req.state,
      resource: req.resource,
      scope: req.scope,
      revolutClientId,
      environment: input.environment,
      expiresAt: this.now() + LINK_TTL_MS,
    });

    const auth = new RevolutAuth(
      this.tenantConfig(revolutClientId, input.environment),
      undefined,
      this.http
    );
    return { linkId, authorizationUrl: auth.buildAuthorizationUrl(linkId) };
  }

  /**
   * Called when Revolut redirects back with a code. Exchanges it for the
   * business's tokens, proves they work, stores the tenant, and mints the
   * authorization code the MCP client has been waiting for.
   */
  async completeLink(
    linkId: string,
    revolutCode: string
  ): Promise<{ redirectTo: string; label?: string }> {
    const link = await this.store.takeLink(linkId);
    if (!link) {
      throw new RevolutLinkError(
        'This connection attempt has expired or was already used.',
        'Start again from your assistant and the link will be re-issued.'
      );
    }
    if (link.expiresAt <= this.now()) {
      throw new RevolutLinkError('This connection attempt timed out.', 'Start again from your assistant.');
    }

    const config = this.tenantConfig(link.revolutClientId, link.environment);
    const source = new MemoryTokenSource();
    const auth = new RevolutAuth(config, source, this.http);

    let tokens: StoredTokens;
    try {
      tokens = await auth.exchangeCode(revolutCode);
    } catch (error) {
      throw new RevolutLinkError(
        'Revolut refused to complete the connection.',
        revolutExchangeHint(error, link.environment)
      );
    }

    // Prove the tokens actually work before telling the assistant it is
    // connected — a consent granted with no permissions ticked would otherwise
    // fail later, inside a tool call, where it is much harder to understand.
    let label: string | undefined;
    try {
      const client = new RevolutClient(config, auth, this.http);
      const accounts = await client.getAccounts();
      label = accounts.find((a) => a.name)?.name ?? undefined;
    } catch {
      throw new RevolutLinkError(
        'Connected, but Revolut would not let us read your accounts.',
        'Re-run the connection and tick at least "Read your account details" on the Revolut consent screen.'
      );
    }

    await this.tenants.upsert({
      clientId: link.revolutClientId,
      environment: link.environment,
      tokens,
      label,
    });

    const code = randomToken();
    await this.store.saveCode(hashToken(code), {
      clientId: link.clientId,
      tenantId: link.revolutClientId,
      redirectUri: link.redirectUri,
      codeChallenge: link.codeChallenge,
      resource: link.resource,
      scope: link.scope,
      expiresAt: this.now() + AUTH_CODE_TTL_MS,
    });

    const location = new URL(link.redirectUri);
    location.searchParams.set('code', code);
    if (link.state) location.searchParams.set('state', link.state);
    return { redirectTo: location.href, label };
  }

  /** Authorization-code grant: verify the code + PKCE, then issue tokens. */
  async exchangeCode(params: {
    code: string;
    codeVerifier?: string;
    redirectUri?: string;
    clientId?: string;
  }): Promise<TokenResponse> {
    const data = await this.store.takeCode(hashToken(params.code));
    if (!data) {
      throw new OAuthError('invalid_grant', 'Authorization code is invalid or was already used.');
    }
    if (data.expiresAt <= this.now()) {
      throw new OAuthError('invalid_grant', 'Authorization code has expired.');
    }
    if (params.clientId && data.clientId !== params.clientId) {
      throw new OAuthError('invalid_grant', 'Authorization code was issued to a different client.');
    }
    if (data.redirectUri !== params.redirectUri) {
      throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request.');
    }
    if (!params.codeVerifier) throw new OAuthError('invalid_request', 'code_verifier is required.');
    if (!safeEqual(base64UrlSha256(params.codeVerifier), data.codeChallenge)) {
      throw new OAuthError('invalid_grant', 'PKCE verification failed.');
    }
    return this.issueTokens(data.clientId, data.tenantId, data.scope);
  }

  /** Refresh grant: verify the refresh token, then issue a fresh access token. */
  async exchangeRefreshToken(params: {
    refreshToken: string;
    clientId?: string;
  }): Promise<TokenResponse> {
    const rec = await this.store.getToken(hashToken(params.refreshToken));
    if (!rec || rec.kind !== 'refresh') throw new OAuthError('invalid_grant', 'Invalid refresh token.');
    if (rec.expiresAt !== null && rec.expiresAt <= this.now()) {
      throw new OAuthError('invalid_grant', 'Refresh token has expired.');
    }
    if (params.clientId && rec.clientId !== params.clientId) {
      throw new OAuthError('invalid_grant', 'Refresh token was issued to a different client.');
    }
    return this.issueTokens(rec.clientId, rec.tenantId, rec.scope, params.refreshToken);
  }

  private async issueTokens(
    clientId: string,
    tenantId: string,
    scope: string | undefined,
    keepRefreshToken?: string
  ): Promise<TokenResponse> {
    const accessToken = randomToken();
    await this.store.saveToken(hashToken(accessToken), {
      kind: 'access',
      clientId,
      tenantId,
      scope,
      expiresAt: this.now() + ACCESS_TOKEN_TTL_MS,
    });

    let refreshToken = keepRefreshToken;
    if (!refreshToken) {
      refreshToken = randomToken();
      await this.store.saveToken(hashToken(refreshToken), {
        kind: 'refresh',
        clientId,
        tenantId,
        scope,
        expiresAt: this.now() + REFRESH_TOKEN_TTL_MS,
      });
    }

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope,
    };
  }

  /**
   * Verifies a bearer access token and resolves the business it belongs to.
   * Throws OAuthError(401) if the token is bad or the business has gone away.
   */
  async verifyBearer(accessToken: string): Promise<Tenant> {
    const rec = await this.store.getToken(hashToken(accessToken));
    if (!rec || rec.kind !== 'access') {
      throw new OAuthError('invalid_token', 'Invalid access token.', 401);
    }
    if (rec.expiresAt !== null && rec.expiresAt <= this.now()) {
      throw new OAuthError('invalid_token', 'Access token has expired.', 401);
    }
    const tenant = await this.tenants.get(rec.tenantId);
    if (!tenant) {
      throw new OAuthError('invalid_token', 'No Revolut Business account is linked to this token.', 401);
    }
    return tenant;
  }

  /** Token revocation (RFC 7009). Accepts either an access or a refresh token. */
  async revoke(token: string): Promise<void> {
    await this.store.deleteToken(hashToken(token));
  }

  /** The per-business config: their client_id and environment, our key and redirect URI. */
  tenantConfig(revolutClientId: string, environment: Environment) {
    return buildTenantConfig({
      clientId: revolutClientId,
      environment,
      privateKey: this.service.privateKey,
      redirectUri: this.service.redirectUri,
    });
  }
}

/**
 * Turns the two failures that actually happen here into something the business
 * can act on. Revolut answers a bad assertion and a stale code with the same
 * opaque 401, so the hint has to cover both.
 */
function revolutExchangeHint(error: unknown, environment: Environment): string {
  const status = (error as { response?: { status?: number } })?.response?.status;
  const portal = environment === 'sandbox' ? 'sandbox Revolut Business' : 'Revolut Business';
  if (status === 401 || status === 400) {
    return (
      `Revolut rejected the exchange. The usual causes: the certificate on your ${portal} ` +
      'account is not the one shown on this page, the redirect URI registered with it is not an ' +
      'exact match, or the consent took more than a couple of minutes. Check those and try again.'
    );
  }
  return 'Revolut did not respond as expected. Wait a moment and try the connection again.';
}
