import fs from 'fs';
import axios, { AxiosInstance } from 'axios';
import jwt from 'jsonwebtoken';
import { Config } from '../config.js';
import { FileTokenSource, isExpired, TokenSource } from './token-source.js';
import { StoredTokens, TokenResponse } from '../types/revolut.js';

const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/**
 * Revolut Business API authentication.
 *
 * The Business API uses OAuth 2.0 with a `private_key_jwt` client assertion:
 *   1. The business authorizes the app in the browser and gets a `code`.
 *   2. We exchange that `code` for access + refresh tokens, authenticating the
 *      request with a JWT signed by our private key (the matching public X.509
 *      certificate is uploaded to the business's Revolut portal).
 *   3. Access tokens are short-lived (~40 min) and refreshed automatically using
 *      the long-lived refresh token (the consent window is ~90 days).
 *
 * Unlike the Open Banking API, the Business API does NOT use mutual TLS — the
 * certificate's private key only signs the JWT; API calls are plain HTTPS with a
 * Bearer token.
 *
 * The class is deliberately tenant-agnostic: `config` says which business and
 * which environment, `tokens` says where that business's tokens are kept. The
 * hosted transport constructs one per request.
 */
export class RevolutAuth {
  private readonly tokens: TokenSource;
  private readonly http: AxiosInstance;

  constructor(
    private readonly config: Config,
    tokenSource?: TokenSource,
    http?: AxiosInstance
  ) {
    this.tokens = tokenSource ?? new FileTokenSource(config.tokenStorePath);
    this.http = http ?? axios;
  }

  private loadPrivateKey(): string | Buffer {
    if (this.config.privateKey) return this.config.privateKey;
    if (this.config.privateKeyPath) return fs.readFileSync(this.config.privateKeyPath);
    throw new Error(
      'No private key configured. Set REVOLUT_PRIVATE_KEY (PEM contents) or REVOLUT_PRIVATE_KEY_PATH.'
    );
  }

  /** Sign a short-lived client-assertion JWT (RS256) for the token endpoint. */
  signClientAssertion(ttlSeconds = 300): string {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: this.config.jwtIssuer,
      sub: this.config.clientId,
      aud: this.config.jwtAudience,
      iat: now,
      exp: now + ttlSeconds,
    };
    return jwt.sign(payload, this.loadPrivateKey(), { algorithm: 'RS256' });
  }

  /** Step 1: the URL the business opens to authorize the app and obtain a `code`. */
  buildAuthorizationUrl(state?: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
    });
    if (state) params.set('state', state);
    return `${this.config.authBaseUrl}/app-confirm?${params.toString()}`;
  }

  /** Step 2: exchange the authorization code for access + refresh tokens. */
  async exchangeCode(code: string): Promise<StoredTokens> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.config.clientId,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: this.signClientAssertion(),
    });

    const response = await this.http.post<TokenResponse>(
      `${this.config.apiBaseUrl}/auth/token`,
      body.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const tokens = toStored(response.data);
    await this.tokens.save(tokens);
    return tokens;
  }

  /** Returns a valid access token, refreshing transparently when expired. */
  async getValidAccessToken(): Promise<string> {
    const stored = await this.tokens.load();
    if (!stored) {
      throw new Error(
        'Not authenticated. Run the setup_auth tool, authorize in the browser, then call complete_auth with the code.'
      );
    }

    if (!isExpired(stored)) return stored.accessToken;

    if (!stored.refreshToken) {
      await this.tokens.clear();
      throw new Error('Session expired and no refresh token available. Re-run setup_auth.');
    }

    return this.refreshAccessToken(stored.refreshToken);
  }

  /** Reads the stored tokens without refreshing — for status reporting. */
  async peekTokens(): Promise<StoredTokens | null> {
    return this.tokens.load();
  }

  private async refreshAccessToken(refreshToken: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.config.clientId,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: this.signClientAssertion(),
    });

    const response = await this.http.post<TokenResponse>(
      `${this.config.apiBaseUrl}/auth/token`,
      body.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    // Refresh responses typically omit a new refresh token — keep the existing one.
    const tokens = toStored(response.data, refreshToken);
    await this.tokens.save(tokens);
    return tokens.accessToken;
  }
}

export function toStored(response: TokenResponse, fallbackRefresh?: string): StoredTokens {
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token ?? fallbackRefresh,
    tokenType: response.token_type,
    expiresAt: Date.now() + response.expires_in * 1000,
    scope: response.scope,
  };
}
