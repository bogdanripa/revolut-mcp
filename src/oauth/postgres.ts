// Postgres-backed OAuth store. Codes and tokens are keyed by their SHA-256
// hash, so the raw secret is never stored. Shares the connection pool with the
// tenant store (both are created in hosted/setup.ts).

import type { Pool } from 'pg';
import { Environment } from '../config.js';
import { OAuthStore, StoredClient, StoredCode, StoredLink, StoredToken } from './store.js';

const CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id                  text PRIMARY KEY,
    client_name                text,
    redirect_uris              jsonb NOT NULL,
    token_endpoint_auth_method text NOT NULL DEFAULT 'none',
    grant_types                jsonb NOT NULL,
    created_at                 timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS oauth_links (
    link_id           text PRIMARY KEY,
    client_id         text NOT NULL,
    redirect_uri      text NOT NULL,
    code_challenge    text NOT NULL,
    state             text,
    resource          text,
    scope             text,
    revolut_client_id text NOT NULL,
    environment       text NOT NULL,
    expires_at        timestamptz NOT NULL
  );
  CREATE TABLE IF NOT EXISTS oauth_codes (
    code_hash      text PRIMARY KEY,
    client_id      text NOT NULL,
    tenant_id      text NOT NULL,
    redirect_uri   text NOT NULL,
    code_challenge text NOT NULL,
    resource       text,
    scope          text,
    expires_at     timestamptz NOT NULL
  );
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    token_hash text PRIMARY KEY,
    kind       text NOT NULL,
    client_id  text NOT NULL,
    tenant_id  text NOT NULL,
    scope      text,
    expires_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS oauth_tokens_tenant_idx ON oauth_tokens (tenant_id);
`;

interface ClientRow {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  grant_types: string[];
  created_at: Date;
}
interface LinkRow {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string | null;
  resource: string | null;
  scope: string | null;
  revolut_client_id: string;
  environment: string;
  expires_at: Date;
}
interface CodeRow {
  client_id: string;
  tenant_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string | null;
  scope: string | null;
  expires_at: Date;
}
interface TokenRow {
  kind: string;
  client_id: string;
  tenant_id: string;
  scope: string | null;
  expires_at: Date | null;
}

export class PostgresOAuthStore implements OAuthStore {
  constructor(private readonly pool: Pool) {}

  async init(): Promise<void> {
    await this.pool.query(CREATE_TABLES);
  }

  /** Drops expired links and codes. Cheap, and keeps the tables from growing without bound. */
  async sweep(): Promise<void> {
    await this.pool.query('DELETE FROM oauth_links WHERE expires_at < now()');
    await this.pool.query('DELETE FROM oauth_codes WHERE expires_at < now()');
    await this.pool.query('DELETE FROM oauth_tokens WHERE expires_at IS NOT NULL AND expires_at < now()');
  }

  async saveClient(client: StoredClient): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, token_endpoint_auth_method, grant_types)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (client_id) DO NOTHING`,
      [
        client.clientId,
        client.clientName ?? null,
        JSON.stringify(client.redirectUris),
        client.tokenEndpointAuthMethod,
        JSON.stringify(client.grantTypes),
      ]
    );
  }

  async getClient(clientId: string): Promise<StoredClient | null> {
    const { rows } = await this.pool.query<ClientRow>(
      'SELECT * FROM oauth_clients WHERE client_id = $1',
      [clientId]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      clientId: row.client_id,
      clientName: row.client_name ?? undefined,
      redirectUris: row.redirect_uris,
      tokenEndpointAuthMethod: row.token_endpoint_auth_method,
      grantTypes: row.grant_types,
      createdAt: row.created_at.getTime(),
    };
  }

  async saveLink(linkId: string, data: StoredLink): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_links (link_id, client_id, redirect_uri, code_challenge, state, resource, scope,
                                revolut_client_id, environment, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        linkId,
        data.clientId,
        data.redirectUri,
        data.codeChallenge,
        data.state ?? null,
        data.resource ?? null,
        data.scope ?? null,
        data.revolutClientId,
        data.environment,
        new Date(data.expiresAt),
      ]
    );
  }

  async takeLink(linkId: string): Promise<StoredLink | null> {
    const { rows } = await this.pool.query<LinkRow>(
      'DELETE FROM oauth_links WHERE link_id = $1 RETURNING *',
      [linkId]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge,
      state: row.state ?? undefined,
      resource: row.resource ?? undefined,
      scope: row.scope ?? undefined,
      revolutClientId: row.revolut_client_id,
      environment: (row.environment === 'production' ? 'production' : 'sandbox') satisfies Environment,
      expiresAt: row.expires_at.getTime(),
    };
  }

  async saveCode(codeHash: string, data: StoredCode): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_codes (code_hash, client_id, tenant_id, redirect_uri, code_challenge, resource, scope, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        codeHash,
        data.clientId,
        data.tenantId,
        data.redirectUri,
        data.codeChallenge,
        data.resource ?? null,
        data.scope ?? null,
        new Date(data.expiresAt),
      ]
    );
  }

  async takeCode(codeHash: string): Promise<StoredCode | null> {
    // DELETE ... RETURNING makes the read single-use in one atomic statement.
    const { rows } = await this.pool.query<CodeRow>(
      'DELETE FROM oauth_codes WHERE code_hash = $1 RETURNING *',
      [codeHash]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      clientId: row.client_id,
      tenantId: row.tenant_id,
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge,
      resource: row.resource ?? undefined,
      scope: row.scope ?? undefined,
      expiresAt: row.expires_at.getTime(),
    };
  }

  async saveToken(tokenHash: string, data: StoredToken): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_tokens (token_hash, kind, client_id, tenant_id, scope, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        tokenHash,
        data.kind,
        data.clientId,
        data.tenantId,
        data.scope ?? null,
        data.expiresAt === null ? null : new Date(data.expiresAt),
      ]
    );
  }

  async getToken(tokenHash: string): Promise<StoredToken | null> {
    const { rows } = await this.pool.query<TokenRow>(
      'SELECT * FROM oauth_tokens WHERE token_hash = $1',
      [tokenHash]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      kind: row.kind === 'refresh' ? 'refresh' : 'access',
      clientId: row.client_id,
      tenantId: row.tenant_id,
      scope: row.scope ?? undefined,
      expiresAt: row.expires_at ? row.expires_at.getTime() : null,
    };
  }

  async deleteToken(tokenHash: string): Promise<void> {
    await this.pool.query('DELETE FROM oauth_tokens WHERE token_hash = $1', [tokenHash]);
  }
}
