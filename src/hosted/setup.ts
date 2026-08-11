// Builds the hosted-mode runtime — the OAuth authorization server and the tenant
// store — from the environment, sharing a single Postgres pool.
//
// Returns undefined when the deployment is not configured for it. The HTTP
// server then still starts (so /health and the homepage answer, and the
// container is diagnosable) but refuses MCP requests, because without a tenant
// store there is no way to tell one business from another.

import { Pool } from 'pg';
import { OAuthProvider, ServiceIdentity } from '../oauth/provider.js';
import { PostgresOAuthStore } from '../oauth/postgres.js';
import { keyFromHex } from '../tenants/crypto.js';
import { PostgresTenantStore } from '../tenants/postgres.js';
import { TenantStore } from '../tenants/store.js';

export interface HostedRuntime {
  oauth: OAuthProvider;
  tenants: TenantStore;
}

/** Which env vars are missing, for a startup log that says what to fix. */
function missing(env: NodeJS.ProcessEnv): string[] {
  const required = {
    DATABASE_URL: env.DATABASE_URL,
    REVOLUT_SESSION_KEY: env.REVOLUT_SESSION_KEY,
    REVOLUT_SERVICE_PRIVATE_KEY: env.REVOLUT_SERVICE_PRIVATE_KEY,
    REVOLUT_SERVICE_CERTIFICATE: env.REVOLUT_SERVICE_CERTIFICATE,
  };
  return Object.entries(required)
    .filter(([, value]) => !value?.trim())
    .map(([name]) => name);
}

/**
 * PEM read out of an environment variable. Docker, shells and CI all mangle real
 * newlines differently, so accept the two forms that actually turn up: literal
 * newlines, and `\n` escapes. A PEM with neither is not a PEM.
 */
export function readPem(value: string | undefined, name: string): string {
  const raw = (value ?? '').trim();
  if (!raw) throw new Error(`${name} is empty.`);
  const pem = raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
  if (!/-----BEGIN [A-Z ]+-----/.test(pem)) {
    throw new Error(`${name} does not look like a PEM block (no -----BEGIN ... ----- header).`);
  }
  return pem;
}

export interface HostedOptions {
  /**
   * The redirect URI businesses register with our certificate. Pinned by
   * PUBLIC_BASE_URL, because the JWT `iss` claim is derived from its host and
   * must be identical for every tenant — deriving it per request would break the
   * moment the container is reached under another hostname.
   */
  callbackUri: string;
}

export async function createHostedRuntime(
  options: HostedOptions,
  env: NodeJS.ProcessEnv = process.env
): Promise<HostedRuntime | undefined> {
  const absent = missing(env);
  if (absent.length > 0) {
    console.error(
      `revolut-mcp: hosted mode disabled (missing ${absent.join(', ')}). HTTP MCP requests will be refused.`
    );
    return undefined;
  }

  try {
    const service: ServiceIdentity = {
      privateKey: readPem(env.REVOLUT_SERVICE_PRIVATE_KEY, 'REVOLUT_SERVICE_PRIVATE_KEY'),
      certificate: readPem(env.REVOLUT_SERVICE_CERTIFICATE, 'REVOLUT_SERVICE_CERTIFICATE'),
      redirectUri: options.callbackUri,
    };

    // A database hiccup must not leave the process crashing on every idle-client
    // drop, and a failure to initialise must not take the whole server down.
    const pool = new Pool({ connectionString: env.DATABASE_URL });
    pool.on('error', (error) => {
      console.error('revolut-mcp: postgres pool error:', error.message);
    });

    const key = keyFromHex(env.REVOLUT_SESSION_KEY);
    const tenants = new PostgresTenantStore(pool, key);
    const store = new PostgresOAuthStore(pool);
    await tenants.init();
    await store.init();
    // Expired links, codes and tokens accumulate otherwise; nothing depends on
    // this finishing, so a failure here must not block startup.
    void store.sweep().catch(() => undefined);

    const oauth = new OAuthProvider(store, tenants, service);
    console.error(`revolut-mcp: hosted mode enabled (callback ${options.callbackUri}).`);
    return { oauth, tenants };
  } catch (error) {
    console.error(
      'revolut-mcp: hosted mode disabled —',
      error instanceof Error ? error.message : error
    );
    return undefined;
  }
}
