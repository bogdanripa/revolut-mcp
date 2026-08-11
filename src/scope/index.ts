import { Config } from '../config.js';
import { Scope, ToolDefinition } from '../utils/tool.js';
import { authScope } from './auth/index.js';
import { connectionScope } from './connection/index.js';
import { accountsScope } from './accounts/index.js';
import { transactionsScope } from './transactions/index.js';
import { counterpartiesScope } from './counterparties/index.js';
import { paymentsScope } from './payments/index.js';
import { foreignExchangeScope } from './foreign-exchange/index.js';
import { teamScope } from './team/index.js';
import { sandboxScope } from './sandbox/index.js';

/** Every scope that exists, in a stable display order. */
export const scopes: Scope[] = [
  authScope,
  connectionScope,
  accountsScope,
  transactionsScope,
  counterpartiesScope,
  paymentsScope,
  foreignExchangeScope,
  teamScope,
  sandboxScope,
];

/** The business-facing scopes — the same set in both transports. */
const CORE_SCOPES: Scope[] = [
  accountsScope,
  transactionsScope,
  counterpartiesScope,
  paymentsScope,
  foreignExchangeScope,
  teamScope,
];

export interface ScopeOptions {
  /** True for the multi-tenant HTTP transport. */
  hosted: boolean;
}

/**
 * The scopes an individual connection should actually see.
 *
 * Two things vary. Authentication: stdio walks the operator through
 * setup_auth/complete_auth, while a hosted tenant authenticated in a browser
 * long before the model was involved and only needs to know *which* account it
 * got. And the sandbox simulators, which are listed only when the connection
 * actually targets the sandbox — offering "top up this account with fake money"
 * against a real business account is noise at best.
 */
export function scopesFor(config: Config, options: ScopeOptions): Scope[] {
  const selected: Scope[] = [options.hosted ? connectionScope : authScope, ...CORE_SCOPES];
  if (config.environment === 'sandbox') selected.push(sandboxScope);
  return selected;
}

/** Flattened list of every tool across every scope. */
export function allTools(): ToolDefinition<any>[] {
  return scopes.flatMap((scope) => scope.tools);
}
