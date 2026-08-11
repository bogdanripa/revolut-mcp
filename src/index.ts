#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getConfig } from './config.js';
import { createHostedRuntime } from './hosted/setup.js';
import { createHttpTransport, listen, loadHttpOptions } from './http/server.js';
import { createServer } from './server.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

const HELP = `${SERVER_NAME} v${SERVER_VERSION} — MCP server for the Revolut Business API.

Two ways to run it:

  stdio (default)   One business, on your machine. Credentials come from the
                    environment; tokens are kept in a local JSON file.
  --http            Multi-tenant and hosted. Businesses connect in a browser
                    through OAuth; one deployment serves any number of them.

stdio configuration (environment variables):
  REVOLUT_CLIENT_ID         (required) Client ID from the Revolut Business portal
  REVOLUT_PRIVATE_KEY_PATH  Path to the PEM private key that signs the JWT
  REVOLUT_PRIVATE_KEY       PEM contents (alternative to the path)
  REVOLUT_REDIRECT_URI      OAuth redirect URI (default: https://example.com/)
  REVOLUT_JWT_ISS           JWT issuer (defaults to the redirect URI host)
  TOKEN_STORE_PATH          Token store path (default: ./.tokens.json)
  REVOLUT_ENVIRONMENT       sandbox (default) or production

hosted configuration (environment variables):
  MCP_TRANSPORT=http            Alternative to passing --http
  PORT                          Port to listen on (default: 80)
  PUBLIC_BASE_URL               This deployment's public origin, e.g. https://revolut-mcp.example.com
  DATABASE_URL                  Postgres connection string
  REVOLUT_SESSION_KEY           32 bytes as 64 hex chars; encrypts stored tokens
  REVOLUT_SERVICE_PRIVATE_KEY   PEM private key that signs every tenant's JWT
  REVOLUT_SERVICE_CERTIFICATE   PEM X.509 certificate businesses register with Revolut

Docs: https://github.com/bogdanripa/revolut-mcp`;

function wantsHttp(argv: string[], env: NodeJS.ProcessEnv): boolean {
  return argv.includes('--http') || env.MCP_TRANSPORT?.trim().toLowerCase() === 'http';
}

async function runHttp(): Promise<void> {
  const options = loadHttpOptions();
  if (!options.publicBaseUrl) {
    // The JWT `iss` claim is derived from this and must match what every business
    // registered with Revolut, so guessing it per request is not an option.
    console.error(
      `revolut-mcp: PUBLIC_BASE_URL is not set; assuming http://localhost:${options.port}. ` +
        'Set it to the deployment\'s public origin or businesses will not be able to connect.'
    );
    options.publicBaseUrl = `http://localhost:${options.port}`;
  }

  const runtime = await createHostedRuntime({
    callbackUri: `${options.publicBaseUrl}/revolut/callback`,
  });
  const server = createHttpTransport(options, runtime);
  await listen(server, options);
  console.error(
    `revolut-mcp listening on http://${options.host}:${options.port} (MCP at ${options.path})`
  );

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

async function runStdio(): Promise<void> {
  const config = getConfig();

  // The client can go away mid-write; that is a normal shutdown, not a crash.
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0);
    throw error;
  });

  const server = createServer(config);
  await server.connect(new StdioServerTransport());
  console.error(`revolut-mcp connected (environment: ${config.environment}).`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }
  if (args.includes('--version') || args.includes('-v')) {
    console.log(`${SERVER_NAME} ${SERVER_VERSION}`);
    return;
  }

  // Hosted mode is multi-tenant: credentials arrive with each request, so the
  // server itself needs none and getConfig() is deliberately not called.
  if (wantsHttp(args, process.env)) return runHttp();
  return runStdio();
}

main().catch((error) => {
  // stdout carries the MCP protocol in stdio mode, so diagnostics go to stderr.
  console.error('Fatal error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
