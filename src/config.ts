import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import path from 'path';

loadDotenv();

export type Environment = 'sandbox' | 'production';

const EnvironmentSchema = z.enum(['sandbox', 'production']).default('sandbox');

const ConfigSchema = z.object({
  clientId: z.string().min(1, 'REVOLUT_CLIENT_ID is required'),
  privateKey: z.string().optional(),
  privateKeyPath: z.string().optional(),
  jwtIssuer: z.string().optional(),
  jwtAudience: z.string().default('https://revolut.com'),
  redirectUri: z.string().url('REVOLUT_REDIRECT_URI must be a valid URL'),
  tokenStorePath: z.string().default('./.tokens.json'),
  environment: EnvironmentSchema,
});

export const ENDPOINTS = {
  sandbox: {
    apiBaseUrl: 'https://sandbox-b2b.revolut.com/api/1.0',
    authBaseUrl: 'https://sandbox-business.revolut.com',
  },
  production: {
    apiBaseUrl: 'https://b2b.revolut.com/api/1.0',
    authBaseUrl: 'https://business.revolut.com',
  },
} as const;

function resolveAbsolute(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

/**
 * The JWT `iss` claim must equal the *host* of the redirect URI registered
 * alongside the certificate — Revolut rejects the assertion otherwise.
 */
export function deriveIssuer(redirectUri: string, explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  try {
    return new URL(redirectUri).hostname;
  } catch {
    return redirectUri;
  }
}

/**
 * Everything needed to talk to Revolut on behalf of ONE business.
 *
 * In stdio mode there is exactly one of these, built from the environment. In
 * hosted mode there is one per tenant, built per request from the tenant record
 * plus the deployment's service certificate — same shape either way, which is
 * why the client and every tool are oblivious to which mode they run under.
 */
export interface Config {
  clientId: string;
  privateKey?: string;
  privateKeyPath?: string;
  jwtIssuer: string;
  jwtAudience: string;
  redirectUri: string;
  tokenStorePath: string;
  environment: Environment;
  apiBaseUrl: string;
  authBaseUrl: string;
}

function buildConfig(): Config {
  const parsed = ConfigSchema.safeParse({
    clientId: process.env.REVOLUT_CLIENT_ID,
    privateKey: process.env.REVOLUT_PRIVATE_KEY,
    privateKeyPath: process.env.REVOLUT_PRIVATE_KEY_PATH,
    jwtIssuer: process.env.REVOLUT_JWT_ISS,
    jwtAudience: process.env.REVOLUT_JWT_AUD,
    redirectUri: process.env.REVOLUT_REDIRECT_URI ?? 'https://example.com/',
    tokenStorePath: process.env.TOKEN_STORE_PATH,
    environment: process.env.REVOLUT_ENVIRONMENT,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid configuration:\n${issues}\n\nCopy .env.sandbox.template → .env and fill in your values.`
    );
  }

  const data = parsed.data;

  if (!data.privateKey && !data.privateKeyPath) {
    throw new Error(
      'Invalid configuration:\n  • Provide REVOLUT_PRIVATE_KEY (PEM contents) or REVOLUT_PRIVATE_KEY_PATH (path to the key file used to sign the client-assertion JWT).'
    );
  }

  const endpoints = ENDPOINTS[data.environment];

  return {
    clientId: data.clientId,
    privateKey: data.privateKey,
    privateKeyPath: data.privateKeyPath ? resolveAbsolute(data.privateKeyPath) : undefined,
    jwtIssuer: deriveIssuer(data.redirectUri, data.jwtIssuer),
    jwtAudience: data.jwtAudience,
    redirectUri: data.redirectUri,
    tokenStorePath: resolveAbsolute(data.tokenStorePath),
    environment: data.environment,
    apiBaseUrl: endpoints.apiBaseUrl,
    authBaseUrl: endpoints.authBaseUrl,
  };
}

/**
 * Builds a per-tenant config for the hosted transport. The tenant supplies the
 * `client_id` it got from its own Revolut portal; the deployment supplies the
 * signing key and the redirect URI every tenant registered against.
 */
export function buildTenantConfig(tenant: {
  clientId: string;
  environment: Environment;
  privateKey: string;
  redirectUri: string;
  jwtIssuer?: string;
  jwtAudience?: string;
}): Config {
  const endpoints = ENDPOINTS[tenant.environment];
  return {
    clientId: tenant.clientId,
    privateKey: tenant.privateKey,
    privateKeyPath: undefined,
    jwtIssuer: deriveIssuer(tenant.redirectUri, tenant.jwtIssuer),
    jwtAudience: tenant.jwtAudience ?? 'https://revolut.com',
    redirectUri: tenant.redirectUri,
    // Hosted tenants never touch the filesystem token store; their tokens live
    // in the database. The field is kept so the shape stays uniform.
    tokenStorePath: '',
    environment: tenant.environment,
    apiBaseUrl: endpoints.apiBaseUrl,
    authBaseUrl: endpoints.authBaseUrl,
  };
}

let _config: Config | null = null;

export function getConfig(): Config {
  if (!_config) _config = buildConfig();
  return _config;
}

export function resetConfig(): void {
  _config = null;
}
