import { allTools, scopes, scopesFor } from '../src/scope/index.js';
import { createServer } from '../src/server.js';
import { zodToJsonSchema } from '../src/utils/json-schema.js';
import { buildTenantConfig, Config } from '../src/config.js';
import { MemoryTokenSource } from '../src/client/token-source.js';

const fakeConfig = {
  clientId: 'cid',
  privateKey: 'KEY',
  privateKeyPath: undefined,
  jwtIssuer: 'example.com',
  jwtAudience: 'https://revolut.com',
  redirectUri: 'https://example.com/',
  tokenStorePath: '/tmp/revolut-test.json',
  environment: 'sandbox',
  apiBaseUrl: 'https://sandbox-b2b.revolut.com/api/1.0',
  authBaseUrl: 'https://sandbox-business.revolut.com',
} as unknown as Config;

function toolNames(config: Config, hosted: boolean): string[] {
  return scopesFor(config, { hosted }).flatMap((scope) => scope.tools.map((tool) => tool.name));
}

describe('tool registry', () => {
  const tools = allTools();

  it('exposes all expected scopes', () => {
    expect(scopes.map((s) => s.name).sort()).toEqual(
      [
        'accounts',
        'auth',
        'connection',
        'counterparties',
        'foreign-exchange',
        'payments',
        'sandbox',
        'team',
        'transactions',
      ].sort()
    );
  });

  it('registers at least 21 tools with unique names', () => {
    expect(tools.length).toBeGreaterThanOrEqual(21);
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every tool has snake_case name, a description, and an object input schema', () => {
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z][a-z_]+$/);
      expect(tool.description.length).toBeGreaterThan(10);
      const json = zodToJsonSchema(tool.schema) as { type?: string };
      expect(json.type).toBe('object');
    }
  });

  it('flags destructive tools with the destructiveHint annotation', () => {
    const destructive = tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name);
    expect(destructive).toContain('delete_counterparty');
    expect(destructive).toContain('cancel_transaction');
  });

  it('builds an MCP server without throwing', () => {
    expect(() => createServer(fakeConfig)).not.toThrow();
    expect(() =>
      createServer(fakeConfig, { hosted: true, tokenSource: new MemoryTokenSource() })
    ).not.toThrow();
  });
});

describe('scope selection', () => {
  const production = buildTenantConfig({
    clientId: 'cid',
    environment: 'production',
    privateKey: 'KEY',
    redirectUri: 'https://revolut-mcp.example.com/revolut/callback',
  });

  it('offers the stdio auth walkthrough only when not hosted', () => {
    expect(toolNames(fakeConfig, false)).toEqual(expect.arrayContaining(['setup_auth', 'complete_auth']));
    expect(toolNames(fakeConfig, false)).not.toContain('get_connection_status');

    expect(toolNames(fakeConfig, true)).toContain('get_connection_status');
    expect(toolNames(fakeConfig, true)).not.toContain('setup_auth');
  });

  it('hides the sandbox simulators from a production connection', () => {
    expect(toolNames(fakeConfig, true)).toEqual(
      expect.arrayContaining(['simulate_topup', 'simulate_transaction_state'])
    );
    expect(toolNames(production, true)).not.toContain('simulate_topup');
    expect(toolNames(production, true)).not.toContain('simulate_transaction_state');
  });

  it('offers the same business tools either way', () => {
    for (const name of [
      'get_accounts',
      'get_transactions',
      'get_counterparties',
      'create_payment',
      'get_exchange_rate',
      'get_team_members',
    ]) {
      expect(toolNames(production, true)).toContain(name);
      expect(toolNames(fakeConfig, false)).toContain(name);
    }
  });
});

describe('buildTenantConfig', () => {
  it('derives the JWT issuer from the callback host and picks the right endpoints', () => {
    const config = buildTenantConfig({
      clientId: 'rev-1',
      environment: 'production',
      privateKey: 'KEY',
      redirectUri: 'https://revolut-mcp.example.com/revolut/callback',
    });
    expect(config.jwtIssuer).toBe('revolut-mcp.example.com');
    expect(config.jwtAudience).toBe('https://revolut.com');
    expect(config.apiBaseUrl).toBe('https://b2b.revolut.com/api/1.0');
    expect(config.authBaseUrl).toBe('https://business.revolut.com');

    const sandbox = buildTenantConfig({
      clientId: 'rev-1',
      environment: 'sandbox',
      privateKey: 'KEY',
      redirectUri: 'https://revolut-mcp.example.com/revolut/callback',
    });
    expect(sandbox.apiBaseUrl).toBe('https://sandbox-b2b.revolut.com/api/1.0');
    expect(sandbox.authBaseUrl).toBe('https://sandbox-business.revolut.com');
  });

  it('never points a hosted tenant at the filesystem token store', () => {
    const config = buildTenantConfig({
      clientId: 'rev-1',
      environment: 'production',
      privateKey: 'KEY',
      redirectUri: 'https://revolut-mcp.example.com/revolut/callback',
    });
    expect(config.tokenStorePath).toBe('');
  });
});
