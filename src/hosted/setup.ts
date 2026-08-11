// Builds the hosted-mode runtime — the OAuth authorization server and the tenant
// store — from the environment, sharing a single Postgres pool.
//
// Returns undefined when the deployment is not configured for it. The HTTP
// server then still starts (so /health and the homepage answer, and the
// container is diagnosable) but refuses MCP requests, because without a tenant
// store there is no way to tell one business from another.

import { createPrivateKey, X509Certificate } from 'crypto';
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
 * PEM read out of an environment variable.
 *
 * Every layer between a keypair and a running container mangles newlines its own
 * way: a shell, a compose file, a JSON body and a control-plane API each get a
 * turn, and escapes survive more than one of them. A value that started as
 * `\n` arrives as `\\n`, whose single-level unescape leaves a stray backslash
 * at the end of every line — still headed `-----BEGIN`, still obviously a PEM to
 * anything that only looks at the header, and completely unparseable. So
 * collapse *any* run of backslashes before an `n`, and drop trailing
 * backslashes: base64 contains neither, so nothing legitimate is lost.
 */
export function readPem(value: string | undefined, name: string): string {
  const raw = (value ?? '').trim();
  if (!raw) throw new Error(`${name} is empty.`);
  const pem = raw.includes('\\')
    ? raw
        .replace(/\\+r/g, '')
        .replace(/\\+n/g, '\n')
        .replace(/\\+$/gm, '')
        .trim()
    : raw;
  if (!/-----BEGIN [A-Z ]+-----/.test(pem)) {
    throw new Error(`${name} does not look like a PEM block (no -----BEGIN ... ----- header).`);
  }
  return pem;
}

/**
 * Parses the service keypair, rather than trusting that it looks like one.
 *
 * A PEM that survived one unescape too many still carries its `-----BEGIN`
 * header, so a header check calls it good and the deployment comes up
 * "healthy" — then every client assertion fails to sign and every business
 * fails to connect, with nothing in the logs pointing back here. Parsing costs
 * microseconds once at startup and turns that into a refusal to start hosted
 * mode at all.
 */
function assertUsableIdentity(service: ServiceIdentity): void {
  try {
    createPrivateKey(service.privateKey);
  } catch (error) {
    throw new Error(
      `REVOLUT_SERVICE_PRIVATE_KEY is not a usable private key: ${
        error instanceof Error ? error.message : error
      }. If it was set from a shell or an API, check that its newlines survived — a stray backslash at each line end is the usual cause.`
    );
  }
  try {
    // eslint-disable-next-line no-new
    new X509Certificate(service.certificate);
  } catch (error) {
    throw new Error(
      `REVOLUT_SERVICE_CERTIFICATE is not a usable X.509 certificate: ${
        error instanceof Error ? error.message : error
      }. Businesses paste this into their Revolut portal, so a mangled one breaks every connection.`
    );
  }
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
    assertUsableIdentity(service);

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
