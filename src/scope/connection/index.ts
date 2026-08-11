import { z } from 'zod';
import { defineTool, Scope } from '../../utils/tool.js';

const emptySchema = z.object({});

/**
 * Hosted-mode replacement for the stdio `auth` scope. There is nothing for the
 * model to do about authentication here — the business connected in a browser —
 * but "which account am I even looking at?" is a real question, and answering it
 * stops the model from guessing when a call comes back empty.
 */
export const connectionScope: Scope = {
  name: 'connection',
  description: 'Inspect which Revolut Business account this connection is bound to.',
  tools: [
    defineTool({
      name: 'get_connection_status',
      description:
        'Reports which Revolut Business account this connection is authorized for, which environment it targets (production or sandbox), when it was connected, and which permissions the business granted. Use it when a call fails with a permission error, or to confirm you are looking at the right account.',
      schema: emptySchema,
      annotations: { title: 'Get connection status', readOnlyHint: true, openWorldHint: false },
      handler: async (_input, { config, tenant, auth }) => {
        const tokens = await auth.peekTokens();
        const lines = [
          `Environment : ${config.environment}`,
          `Business    : ${tenant?.label ?? '(name not captured)'}`,
        ];
        if (tenant?.createdAt) {
          lines.push(`Connected   : ${new Date(tenant.createdAt).toISOString().slice(0, 10)}`);
        }
        lines.push(
          `Permissions : ${
            tokens?.scope ??
            '(not reported by Revolut — if a call fails with a permission error, reconnect and tick the permission you need)'
          }`
        );
        if (config.environment === 'sandbox') {
          lines.push('', 'This is a sandbox connection: the money and documents here are not real.');
        }
        return lines.join('\n');
      },
    }),
  ],
};
