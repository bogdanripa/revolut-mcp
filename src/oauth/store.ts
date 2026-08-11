// Storage for the OAuth authorization server we present to MCP clients:
// clients registered via Dynamic Client Registration, in-flight link requests
// (a business is off at Revolut's consent screen), one-time authorization
// codes, and access/refresh tokens.
//
// Codes and tokens are stored HASHED (SHA-256) — a database leak never exposes
// a live bearer token or authorization code. An in-memory implementation backs
// the tests; the Postgres one (postgres.ts) is wired in production.

import { Environment } from '../config.js';

export interface StoredClient {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: string;
  grantTypes: string[];
  createdAt: number;
}

/** The original MCP-client authorization request, preserved across the Revolut round-trip. */
export interface StoredLink {
  /** Our OAuth client (the MCP client), not the business's Revolut client_id. */
  clientId: string;
  redirectUri: string;
  /** PKCE S256 challenge the MCP client committed to at /authorize. */
  codeChallenge: string;
  /** The MCP client's `state`, echoed back verbatim on the final redirect. */
  state?: string;
  resource?: string;
  scope?: string;
  /** The business's Revolut client_id, typed into the connect page. */
  revolutClientId: string;
  environment: Environment;
  /** ms epoch. */
  expiresAt: number;
}

export interface StoredCode {
  clientId: string;
  /** The connected business — a Revolut client_id, the tenant key. */
  tenantId: string;
  redirectUri: string;
  codeChallenge: string;
  resource?: string;
  scope?: string;
  /** ms epoch. */
  expiresAt: number;
}

export interface StoredToken {
  kind: 'access' | 'refresh';
  clientId: string;
  tenantId: string;
  scope?: string;
  /** ms epoch, or null for no expiry. */
  expiresAt: number | null;
}

export interface OAuthStore {
  saveClient(client: StoredClient): Promise<void>;
  getClient(clientId: string): Promise<StoredClient | null>;

  saveLink(linkId: string, data: StoredLink): Promise<void>;
  /** Returns and atomically DELETES the link — a consent round-trip is single-use. */
  takeLink(linkId: string): Promise<StoredLink | null>;

  saveCode(codeHash: string, data: StoredCode): Promise<void>;
  /** Returns and atomically DELETES the code — authorization codes are single-use. */
  takeCode(codeHash: string): Promise<StoredCode | null>;

  saveToken(tokenHash: string, data: StoredToken): Promise<void>;
  getToken(tokenHash: string): Promise<StoredToken | null>;
  deleteToken(tokenHash: string): Promise<void>;
}

/** In-memory store for tests. */
export class InMemoryOAuthStore implements OAuthStore {
  private readonly clients = new Map<string, StoredClient>();
  private readonly links = new Map<string, StoredLink>();
  private readonly codes = new Map<string, StoredCode>();
  private readonly tokens = new Map<string, StoredToken>();

  async saveClient(client: StoredClient): Promise<void> {
    this.clients.set(client.clientId, client);
  }
  async getClient(clientId: string): Promise<StoredClient | null> {
    return this.clients.get(clientId) ?? null;
  }
  async saveLink(linkId: string, data: StoredLink): Promise<void> {
    this.links.set(linkId, data);
  }
  async takeLink(linkId: string): Promise<StoredLink | null> {
    const link = this.links.get(linkId) ?? null;
    this.links.delete(linkId);
    return link;
  }
  async saveCode(codeHash: string, data: StoredCode): Promise<void> {
    this.codes.set(codeHash, data);
  }
  async takeCode(codeHash: string): Promise<StoredCode | null> {
    const code = this.codes.get(codeHash) ?? null;
    this.codes.delete(codeHash);
    return code;
  }
  async saveToken(tokenHash: string, data: StoredToken): Promise<void> {
    this.tokens.set(tokenHash, data);
  }
  async getToken(tokenHash: string): Promise<StoredToken | null> {
    return this.tokens.get(tokenHash) ?? null;
  }
  async deleteToken(tokenHash: string): Promise<void> {
    this.tokens.delete(tokenHash);
  }
}
