// Postgres-backed tenant store. The Revolut access + refresh tokens are
// encrypted at rest with REVOLUT_SESSION_KEY; nothing else about a business is
// stored. DATABASE_URL is injected by the platform.

import type { Pool } from 'pg';
import { Environment } from '../config.js';
import { StoredTokens } from '../types/revolut.js';
import { decrypt, encrypt } from './crypto.js';
import { NewTenant, Tenant, TenantStore } from './store.js';

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS tenants (
    client_id   text PRIMARY KEY,
    environment text NOT NULL,
    tokens_enc  text NOT NULL,
    label       text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
  )
`;

interface TenantRow {
  client_id: string;
  environment: string;
  tokens_enc: string;
  label: string | null;
  created_at: Date;
  updated_at: Date;
}

export class PostgresTenantStore implements TenantStore {
  constructor(
    private readonly pool: Pool,
    private readonly key: Buffer
  ) {}

  /** Creates the table if needed. Call once at startup. */
  async init(): Promise<void> {
    await this.pool.query(CREATE_TABLE);
  }

  async get(clientId: string): Promise<Tenant | null> {
    const { rows } = await this.pool.query<TenantRow>(
      'SELECT * FROM tenants WHERE client_id = $1',
      [clientId]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      clientId: row.client_id,
      environment: row.environment === 'production' ? 'production' : 'sandbox',
      tokens: JSON.parse(decrypt(row.tokens_enc, this.key)) as StoredTokens,
      label: row.label ?? undefined,
      createdAt: row.created_at.getTime(),
      updatedAt: row.updated_at.getTime(),
    };
  }

  async upsert(tenant: NewTenant): Promise<void> {
    await this.pool.query(
      `INSERT INTO tenants (client_id, environment, tokens_enc, label, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (client_id) DO UPDATE SET
         environment = EXCLUDED.environment,
         tokens_enc  = EXCLUDED.tokens_enc,
         label       = COALESCE(EXCLUDED.label, tenants.label),
         updated_at  = now()`,
      [
        tenant.clientId,
        tenant.environment satisfies Environment,
        encrypt(JSON.stringify(tenant.tokens), this.key),
        tenant.label ?? null,
      ]
    );
  }

  async updateTokens(clientId: string, tokens: StoredTokens): Promise<void> {
    await this.pool.query(
      'UPDATE tenants SET tokens_enc = $1, updated_at = now() WHERE client_id = $2',
      [encrypt(JSON.stringify(tokens), this.key), clientId]
    );
  }

  async delete(clientId: string): Promise<void> {
    await this.pool.query('DELETE FROM tenants WHERE client_id = $1', [clientId]);
  }

  async count(): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>('SELECT count(*) FROM tenants');
    return Number(rows[0]?.count ?? 0);
  }
}
