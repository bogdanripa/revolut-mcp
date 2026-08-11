import { createPrivateKey, generateKeyPairSync } from 'crypto';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHostedRuntime, readPem } from '../src/hosted/setup.js';

const PEM = `-----BEGIN CERTIFICATE-----
MIIDZzCCAk+gAwIBAgIUV8hOYitDAw0S5nQNXGacEmDjuSc
BQAwQzErMCkGA1UEAwwicmV2b2x1dC1tY3AtY29vbGlmeQ==
-----END CERTIFICATE-----`;

describe('readPem', () => {
  it('passes a PEM with real newlines through unchanged', () => {
    expect(readPem(PEM, 'X')).toBe(PEM);
  });

  it('unescapes a single-level \\n, the form an env var usually carries', () => {
    expect(readPem(PEM.replace(/\n/g, '\\n'), 'X')).toBe(PEM);
  });

  /**
   * The one that actually bit: a value escaped once by the caller and again by
   * the transport arrives as `\\n`. Unescaping a single level leaves a stray
   * backslash at every line end — still headed -----BEGIN, so a header check
   * calls it valid, and nothing can parse it.
   */
  it('unescapes a double-escaped \\\\n instead of leaving a trailing backslash', () => {
    const doubled = PEM.replace(/\n/g, '\\\\n');
    const result = readPem(doubled, 'X');
    expect(result).toBe(PEM);
    expect(result).not.toContain('\\');
  });

  it('survives \\r\\n line endings', () => {
    expect(readPem(PEM.replace(/\n/g, '\\r\\n'), 'X')).toBe(PEM);
  });

  it('rejects an empty value and one that is not a PEM at all', () => {
    expect(() => readPem(undefined, 'X')).toThrow(/empty/);
    expect(() => readPem('   ', 'X')).toThrow(/empty/);
    expect(() => readPem('not a pem', 'X')).toThrow(/PEM block/);
  });
});

describe('createHostedRuntime', () => {
  const base = {
    DATABASE_URL: 'postgresql://user:pw@localhost:5432/db',
    REVOLUT_SESSION_KEY: 'a'.repeat(64),
  };
  const options = { callbackUri: 'https://revolut-mcp.example.com/revolut/callback' };

  let certificate: string;
  let privateKey: string;
  let dir: string;

  beforeAll(() => {
    // A real self-signed pair, so the startup parse is exercised for real.
    dir = mkdtempSync(path.join(tmpdir(), 'revolut-mcp-'));
    const keyPath = path.join(dir, 'k.pem');
    const certPath = path.join(dir, 'c.pem');
    execFileSync('openssl', ['genrsa', '-out', keyPath, '2048'], { stdio: 'ignore' });
    execFileSync(
      'openssl',
      ['req', '-new', '-x509', '-key', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=test'],
      { stdio: 'ignore' }
    );
    privateKey = require('fs').readFileSync(keyPath, 'utf8');
    certificate = require('fs').readFileSync(certPath, 'utf8');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  let errors: string[];
  let spy: jest.SpyInstance;
  beforeEach(() => {
    errors = [];
    spy = jest.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args.map(String).join(' '));
    });
  });
  afterEach(() => spy.mockRestore());

  it('stays disabled, naming what is missing, rather than half-starting', async () => {
    await expect(createHostedRuntime(options, {} as NodeJS.ProcessEnv)).resolves.toBeUndefined();
    expect(errors.join('\n')).toContain('DATABASE_URL');
    expect(errors.join('\n')).toContain('REVOLUT_SERVICE_PRIVATE_KEY');
  });

  it('refuses a private key that cannot be parsed, however PEM-shaped it looks', async () => {
    const runtime = await createHostedRuntime(options, {
      ...base,
      REVOLUT_SERVICE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nnot-base64\n-----END PRIVATE KEY-----',
      REVOLUT_SERVICE_CERTIFICATE: certificate,
    } as NodeJS.ProcessEnv);
    expect(runtime).toBeUndefined();
    expect(errors.join('\n')).toMatch(/not a usable private key/);
  });

  it('refuses a certificate that cannot be parsed', async () => {
    const runtime = await createHostedRuntime(options, {
      ...base,
      REVOLUT_SERVICE_PRIVATE_KEY: privateKey,
      REVOLUT_SERVICE_CERTIFICATE: '-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----',
    } as NodeJS.ProcessEnv);
    expect(runtime).toBeUndefined();
    expect(errors.join('\n')).toMatch(/not a usable X.509 certificate/);
  });

  it('accepts a double-escaped keypair — the shape the deployment actually received', () => {
    // Not through createHostedRuntime (that would need a live database); this is
    // the part that was silently broken in production.
    const mangled = privateKey.replace(/\n/g, '\\\\n');
    expect(() => createPrivateKey(readPem(mangled, 'K'))).not.toThrow();
  });
});
