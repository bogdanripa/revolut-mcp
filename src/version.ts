// Server identity reported to MCP clients. The version is read from package.json
// at runtime so it always matches the published package (CI sets package.json).
import { readFileSync } from 'fs';
import path from 'path';

export const SERVER_NAME = 'revolut-mcp';

function resolveVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const SERVER_VERSION = resolveVersion();

/**
 * The commit this image was built from, baked in at build time.
 *
 * During a redeploy the outgoing container is still serving, so a health check
 * that only asks "did something answer 200?" is satisfied by the container being
 * replaced. Reporting the build lets CI wait for the one it just built, and
 * tells anyone looking at a running box what is actually on it. "dev" outside a
 * built image.
 */
export const BUILD_SHA = process.env.BUILD_SHA?.trim() || 'dev';
