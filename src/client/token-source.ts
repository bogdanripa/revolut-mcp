import { StoredTokens } from '../types/revolut.js';
import { TokenStore } from './token-store.js';

/**
 * Where one tenant's Revolut tokens live.
 *
 * stdio mode backs this with a JSON file on the operator's machine; the hosted
 * transport backs it with the tenant row in Postgres. Everything above this
 * interface — {@link RevolutAuth}, the client, every tool — is identical in
 * both modes.
 */
export interface TokenSource {
  load(): Promise<StoredTokens | null>;
  save(tokens: StoredTokens): Promise<void>;
  clear(): Promise<void>;
}

/** File-backed token source: one business, one machine, one JSON file. */
export class FileTokenSource implements TokenSource {
  private readonly store: TokenStore;

  constructor(filePath: string) {
    this.store = new TokenStore(filePath);
  }

  async load(): Promise<StoredTokens | null> {
    return this.store.load();
  }

  async save(tokens: StoredTokens): Promise<void> {
    this.store.save(tokens);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}

/** In-memory token source, for tests and for a one-shot token exchange. */
export class MemoryTokenSource implements TokenSource {
  constructor(private tokens: StoredTokens | null = null) {}

  async load(): Promise<StoredTokens | null> {
    return this.tokens;
  }

  async save(tokens: StoredTokens): Promise<void> {
    this.tokens = tokens;
  }

  async clear(): Promise<void> {
    this.tokens = null;
  }
}

/** True when the access token is gone or within `bufferSeconds` of expiring. */
export function isExpired(tokens: StoredTokens, bufferSeconds = 60): boolean {
  return Date.now() >= tokens.expiresAt - bufferSeconds * 1000;
}
