// Raw node:http router for the OAuth authorization-server endpoints:
//   GET  /.well-known/oauth-authorization-server    (RFC 8414 metadata)
//   GET  /.well-known/oauth-protected-resource[/mcp](RFC 9728 metadata)
//   POST /register                                   (RFC 7591 DCR)
//   GET  /authorize                                  (connect page)
//   POST /authorize                                  (submit -> off to Revolut)
//   GET  /revolut/callback                           (back from Revolut -> code)
//   POST /token                                      (code / refresh grants)
//   POST /revoke                                     (RFC 7009)
//   GET  /certificate.pem                            (the cert businesses register)
//
// handleOAuthRequest returns true once it has handled the request, so the main
// transport can fall through to the MCP endpoint otherwise.

import type { IncomingMessage, ServerResponse } from 'http';
import { Environment } from '../config.js';
import {
  clearCookie,
  CORS_HEADERS,
  readBody,
  readCookie,
  redirect,
  sendHtml,
  sendJson,
  sendText,
  setCookie,
} from '../http/helpers.js';
import { renderConnectPage, renderNoticePage } from './page.js';
import { type AuthorizeRequest, OAuthError, type OAuthProvider, RevolutLinkError } from './provider.js';

/** Carries the in-flight link id across the hop to Revolut and back. */
const LINK_COOKIE = 'revolut_mcp_link';
const LINK_COOKIE_MAX_AGE = 30 * 60;

export interface OAuthContext {
  provider: OAuthProvider;
  /** Absolute base URL of this deployment, no trailing slash (e.g. https://host). */
  baseUrl: string;
  /** MCP endpoint path, e.g. /mcp. */
  mcpPath: string;
}

function authorizationServerMetadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    revocation_endpoint: `${base}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['revolut'],
  };
}

function protectedResourceMetadata(base: string, mcpPath: string) {
  return {
    resource: `${base}${mcpPath}`,
    authorization_servers: [base],
    resource_name: 'revolut-mcp',
    scopes_supported: ['revolut'],
  };
}

function authorizeRequestFrom(get: (name: string) => string | undefined): AuthorizeRequest {
  return {
    clientId: get('client_id') ?? '',
    redirectUri: get('redirect_uri') ?? '',
    codeChallenge: get('code_challenge') ?? '',
    codeChallengeMethod: get('code_challenge_method') ?? '',
    responseType: get('response_type') ?? '',
    state: get('state'),
    resource: get('resource'),
    scope: get('scope'),
  };
}

export async function handleOAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: OAuthContext
): Promise<boolean> {
  const { provider, baseUrl, mcpPath } = ctx;
  const path = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();
  const secure = baseUrl.startsWith('https://');

  const isOAuthPath =
    path === '/.well-known/oauth-authorization-server' ||
    path === '/.well-known/oauth-protected-resource' ||
    path === `/.well-known/oauth-protected-resource${mcpPath}` ||
    path === '/register' ||
    path === '/authorize' ||
    path === '/revolut/callback' ||
    path === '/token' ||
    path === '/revoke' ||
    path === '/certificate.pem';
  if (!isOAuthPath) return false;

  if (method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return true;
  }

  if (path === '/certificate.pem' && method === 'GET') {
    // Public by design: it is the certificate every business pastes into its own
    // Revolut portal. The private half never leaves the container.
    sendText(res, 200, `${provider.certificate.trim()}\n`, 'application/x-pem-file; charset=utf-8');
    return true;
  }

  if (path === '/.well-known/oauth-authorization-server' && method === 'GET') {
    sendJson(res, 200, authorizationServerMetadata(baseUrl), CORS_HEADERS);
    return true;
  }

  if (
    (path === '/.well-known/oauth-protected-resource' ||
      path === `/.well-known/oauth-protected-resource${mcpPath}`) &&
    method === 'GET'
  ) {
    sendJson(res, 200, protectedResourceMetadata(baseUrl, mcpPath), CORS_HEADERS);
    return true;
  }

  if (path === '/register' && method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      const info = await provider.registerClient(body);
      sendJson(res, 201, info, CORS_HEADERS);
    } catch (error) {
      sendOAuthError(res, error);
    }
    return true;
  }

  if (path === '/authorize' && method === 'GET') {
    const request = authorizeRequestFrom((name) => url.searchParams.get(name) ?? undefined);
    try {
      const client = await provider.validateAuthorizeRequest(request);
      sendHtml(
        res,
        200,
        renderConnectPage({
          params: queryParams(url),
          clientName: client.clientName,
          certificate: provider.certificate,
          redirectUri: provider.callbackUri,
        })
      );
    } catch (error) {
      // Never redirect for an invalid client/redirect_uri — show a plain error.
      sendHtml(res, 400, invalidRequestPage(error));
    }
    return true;
  }

  if (path === '/authorize' && method === 'POST') {
    const form = new URLSearchParams(await readBody(req));
    const request = authorizeRequestFrom((name) => form.get(name) ?? undefined);
    const revolutClientId = form.get('revolut_client_id') ?? '';
    const environment: Environment = form.get('environment') === 'sandbox' ? 'sandbox' : 'production';

    try {
      const { linkId, authorizationUrl } = await provider.beginLink(request, {
        revolutClientId,
        environment,
      });
      // `state` is also on the URL; the cookie is the belt to that braces, since
      // an authorization server is not obliged to echo it back.
      redirect(res, authorizationUrl, {
        'Set-Cookie': setCookie(LINK_COOKIE, linkId, LINK_COOKIE_MAX_AGE, secure),
      });
    } catch (error) {
      if (error instanceof RevolutLinkError) {
        const client = await provider.validateAuthorizeRequest(request).catch(() => undefined);
        sendHtml(
          res,
          400,
          renderConnectPage({
            params: formParams(form),
            clientName: client?.clientName,
            certificate: provider.certificate,
            redirectUri: provider.callbackUri,
            error: error.message,
            hint: error.hint,
            values: { revolutClientId, environment },
          })
        );
        return true;
      }
      sendHtml(res, 400, invalidRequestPage(error));
    }
    return true;
  }

  if (path === '/revolut/callback' && method === 'GET') {
    const clear = clearCookie(LINK_COOKIE, secure);
    const code = url.searchParams.get('code');
    const linkId = url.searchParams.get('state') ?? readCookie(req, LINK_COOKIE);

    // Revolut reports a refusal on the redirect rather than by failing the call.
    const denied = url.searchParams.get('error');
    if (denied) {
      sendHtml(
        res,
        400,
        renderNoticePage({
          title: 'Revolut did not approve the connection',
          message:
            url.searchParams.get('error_description') ??
            'The authorization was declined or cancelled in Revolut.',
          hint: 'Start the connection again from your assistant to retry.',
        }),
        { 'Set-Cookie': clear }
      );
      return true;
    }

    if (code && !linkId) {
      // Revolut approved something we never asked for. The cause is usually
      // benign and worth naming: pressing "Enable access" on the certificate in
      // the Revolut portal runs this very same approval, but Revolut builds
      // that link itself, so it carries no reference to any connection of ours.
      // Nothing here is salvageable — the code belongs to a request we did not
      // make, and we do not know which client was waiting — but the person is
      // one step from success and should be told that rather than left to
      // guess what they broke.
      sendHtml(
        res,
        400,
        renderNoticePage({
          title: 'Almost — but start this from your assistant',
          message:
            'Revolut approved the access, but the approval was started from the Revolut portal ' +
            '(usually the "Enable access" button), so we have no record of which connection it ' +
            'belongs to.',
          hint:
            'Nothing is broken and nothing needs undoing. Go back to your assistant and start the ' +
            'connection from there — it sends you through this same Revolut approval, and that ' +
            'one we can complete. Your Client ID has not changed.',
        }),
        { 'Set-Cookie': clear }
      );
      return true;
    }

    if (!code || !linkId) {
      sendHtml(
        res,
        400,
        renderNoticePage({
          title: "Couldn't finish connecting",
          message: 'Revolut sent us back without the information we need to finish.',
          hint: 'Start the connection again from your assistant, and keep it in the same browser tab.',
        }),
        { 'Set-Cookie': clear }
      );
      return true;
    }

    try {
      const { redirectTo } = await provider.completeLink(linkId, code);
      redirect(res, redirectTo, { 'Set-Cookie': clear });
    } catch (error) {
      const message =
        error instanceof RevolutLinkError ? error.message : "Couldn't finish connecting to Revolut.";
      const hint = error instanceof RevolutLinkError ? error.hint : undefined;
      if (!(error instanceof RevolutLinkError)) {
        console.error(
          'revolut-mcp: link failed:',
          error instanceof Error ? error.message : error
        );
      }
      sendHtml(res, 400, renderNoticePage({ title: 'Connection failed', message, hint }), {
        'Set-Cookie': clear,
      });
    }
    return true;
  }

  if (path === '/token' && method === 'POST') {
    try {
      const form = new URLSearchParams(await readBody(req));
      const grantType = form.get('grant_type');
      let tokens;
      if (grantType === 'authorization_code') {
        tokens = await provider.exchangeCode({
          code: form.get('code') ?? '',
          codeVerifier: form.get('code_verifier') ?? undefined,
          redirectUri: form.get('redirect_uri') ?? undefined,
          clientId: form.get('client_id') ?? undefined,
        });
      } else if (grantType === 'refresh_token') {
        tokens = await provider.exchangeRefreshToken({
          refreshToken: form.get('refresh_token') ?? '',
          clientId: form.get('client_id') ?? undefined,
        });
      } else {
        throw new OAuthError('unsupported_grant_type', `Unsupported grant_type: ${grantType ?? '(none)'}.`);
      }
      sendJson(res, 200, tokens, { ...CORS_HEADERS, 'Cache-Control': 'no-store' });
    } catch (error) {
      sendOAuthError(res, error);
    }
    return true;
  }

  if (path === '/revoke' && method === 'POST') {
    try {
      const form = new URLSearchParams(await readBody(req));
      const token = form.get('token');
      if (token) await provider.revoke(token);
      // RFC 7009: respond 200 whether or not the token existed.
      sendJson(res, 200, {}, CORS_HEADERS);
    } catch (error) {
      sendOAuthError(res, error);
    }
    return true;
  }

  // A known OAuth path with the wrong method.
  sendJson(res, 405, { error: 'method_not_allowed' }, CORS_HEADERS);
  return true;
}

function queryParams(url: URL): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of url.searchParams) out[key] = value;
  return out;
}

function formParams(form: URLSearchParams): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of form) out[key] = value;
  return out;
}

function sendOAuthError(res: ServerResponse, error: unknown): void {
  if (error instanceof OAuthError) {
    sendJson(res, error.status, { error: error.code, error_description: error.message }, CORS_HEADERS);
    return;
  }
  sendJson(
    res,
    400,
    { error: 'invalid_request', error_description: 'The request could not be processed.' },
    CORS_HEADERS
  );
}

function invalidRequestPage(error: unknown): string {
  return renderNoticePage({
    title: "Couldn't start the connection",
    message: error instanceof OAuthError ? error.message : 'The authorization request was invalid.',
    hint: 'This usually means the assistant sent an incomplete request. Remove the connector and add it again.',
  });
}
