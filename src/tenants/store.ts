import { Environment } from '../config.js';
import { StoredTokens } from '../types/revolut.js';
import { TokenSource } from '../client/token-source.js';

/**
 * One connected business.
 *
 * The key is the Revolut `client_id`, which the business generated in its own
 * Revolut portal when it registered our certificate. It is unique per business
 * per environment, and Revolut only ever issues a consent for it to someone
 * signed into that business — so it is a safe tenant identity.
 */
export interface Tenant {
  clientId: string;
  environment: Environment;
  /** Revolut access + refresh tokens. Encrypted at rest by the Postgres store. */
  tokens: StoredTokens;
  /** Display label captured at connect time, e.g. the first account's name. */
  label?: string;
  createdAt: number;
  updatedAt: number;
}

export type NewTenant = Pick<Tenant, 'clientId' | 'environment' | 'tokens' | 'label'>;

export interface TenantStore {
  get(clientId: string): Promise<Tenant | null>;
  /** Connect (or reconnect) a business: replaces its tokens wholesale. */
  upsert(tenant: NewTenant): Promise<void>;
  /** Persist refreshed tokens without touching anything else. */
  updateTokens(clientId: string, tokens: StoredTokens): Promise<void>;
  delete(clientId: string): Promise<void>;
  count(): Promise<number>;
}

/** In-memory tenant store, for tests. Holds plaintext — encryption is the Postgres store's job. */
export class InMemoryTenantStore implements TenantStore {
  private readonly rows = new Map<string, Tenant>();

  async get(clientId: string): Promise<Tenant | null> {
    const row = this.rows.get(clientId);
    return row ? { ...row, tokens: { ...row.tokens } } : null;
  }

  async upsert(tenant: NewTenant): Promise<void> {
    const now = Date.now();
    const existing = this.rows.get(tenant.clientId);
    this.rows.set(tenant.clientId, {
      ...tenant,
      tokens: { ...tenant.tokens },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async updateTokens(clientId: string, tokens: StoredTokens): Promise<void> {
    const row = this.rows.get(clientId);
    if (!row) return;
    row.tokens = { ...tokens };
    row.updatedAt = Date.now();
  }

  async delete(clientId: string): Promise<void> {
    this.rows.delete(clientId);
  }

  async count(): Promise<number> {
    return this.rows.size;
  }
}

/**
 * Token source that reads and writes one tenant's row. Handed to RevolutAuth so
 * a refreshed access token is persisted for the next request — containers here
 * sleep when idle, so in-process caching would buy nothing.
 */
export function tenantTokenSource(store: TenantStore, tenant: Tenant): TokenSource {
  let current: StoredTokens = tenant.tokens;
  return {
    async load(): Promise<StoredTokens | null> {
      return current;
    },
    async save(tokens: StoredTokens): Promise<void> {
      current = tokens;
      await store.updateTokens(tenant.clientId, tokens);
    },
    async clear(): Promise<void> {
      // A tenant whose refresh token died keeps its row: the business reconnects
      // through the same flow and the row is overwritten. Deleting here would
      // also throw away the label and the connection date for no gain.
    },
  };
}
