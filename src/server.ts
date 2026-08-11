import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Config } from './config.js';
import { RevolutAuth } from './client/auth.js';
import { RevolutClient } from './client/revolut-client.js';
import { TokenSource } from './client/token-source.js';
import type { Tenant } from './tenants/store.js';
import { ToolContext, ToolDefinition } from './utils/tool.js';
import { zodToJsonSchema } from './utils/json-schema.js';
import { formatError } from './utils/errors.js';
import { scopesFor } from './scope/index.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

const INSTRUCTIONS = `Tools for the Revolut Business API. They act on one real company's bank accounts:
balances, transactions and — where the business granted the permission — outgoing
money.

Amounts are in major units with an explicit currency, and an account only ever
holds one currency. A business usually has several accounts, one per currency, so
"what's my balance?" has no single answer: call get_accounts and report them per
currency rather than summing across them.

Transactions are listed newest-first and the window is capped. get_transactions
defaults to a small count — pass an explicit from/to date range when the user
asks about a period, and say what range you actually read so a partial answer is
never mistaken for a complete one. Reconciliation work ("which invoices got
paid?") lives here: pull the range, then match on counterparty and amount.

Permissions are granted per business on Revolut's own consent screen, and they
are frequently read-only. A 403 means the business did not grant that
capability, not that the call was malformed — say so plainly instead of retrying
or working around it. get_connection_status shows what was granted.

Moving money is irreversible. create_payment and transfer send real funds;
confirm the counterparty, the amount and the currency with the user before
calling either, and never infer a counterparty from a partial name match —
resolve it with get_counterparties first. Prefer reading over writing whenever a
question can be answered by reading.`;

export interface CreateServerOptions {
  /** Where this connection's Revolut tokens live. Defaults to the file store. */
  tokenSource?: TokenSource;
  /** True for the multi-tenant HTTP transport — changes which scopes are offered. */
  hosted?: boolean;
  /** The connected business, in hosted mode. */
  tenant?: Tenant;
}

/** Build the MCP server for one connection, wiring its scopes to the Revolut client. */
export function createServer(config: Config, options: CreateServerOptions = {}): Server {
  const auth = new RevolutAuth(config, options.tokenSource);
  const client = new RevolutClient(config, auth);
  const ctx: ToolContext = { config, auth, client, tenant: options.tenant };

  const tools: ToolDefinition<any>[] = scopesFor(config, {
    hosted: options.hosted ?? false,
  }).flatMap((scope) => scope.tools);
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.schema) as { type: 'object' },
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);

    if (!tool) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }

    try {
      const parsed = tool.schema.parse(args ?? {});
      const text = await tool.handler(parsed, ctx);
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${formatError(error)}` }], isError: true };
    }
  });

  return server;
}
