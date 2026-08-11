<p align="center">
  <img src="assets/revolut-mcp-banner.png" alt="revolut-mcp" width="640">
</p>

# revolut-mcp

An MCP server for the [Revolut **Business**](https://business.revolut.com/) API. It lets an MCP
client read accounts and balances, go through transactions, manage counterparties, and — where the
business granted the permission — make payments, transfers and currency exchanges.

> **Hosted instance:** a public deployment runs at
> <https://revolut-mcp-coolify.bogdanripa.com/>. Open it in a browser to connect your own Revolut
> Business account and get a connector URL. Not affiliated with Revolut.

It runs two ways:

- **stdio**, single business, on your machine — credentials come from the environment.
- **HTTP**, multi-tenant, hosted — each business connects through OAuth in a browser, so one
  deployment serves any number of them.

This is a community project. Everything it touches is a real bank account.

---

## How the hosted flow works

Revolut Business has no API for registering an API client: every business creates its own, in its
own portal. That one step cannot be automated, so the hosted deployment does everything around it.

1. The MCP client registers itself (RFC 7591) and sends the user to `/authorize`.
2. The connect page hands the business two values to paste into
   **Revolut → Settings → APIs → Add API certificate**: this deployment's public X.509 certificate
   (also at [`/certificate.pem`](https://revolut-mcp-coolify.bogdanripa.com/certificate.pem)) and
   the redirect URI `https://<host>/revolut/callback`. Both have copy buttons; the page deep-links
   straight to the right Revolut settings page for production or sandbox.
3. The business pastes back the **Client ID** Revolut issued and is sent to Revolut's own consent
   screen. Revolut redirects to `/revolut/callback`.
4. The server exchanges that code for the business's tokens, signing the `private_key_jwt` client
   assertion with the deployment's private key, then **reads the account list to prove the consent
   actually works** before reporting success.
5. Only then is an authorization code minted for the MCP client, which redeems it for a bearer
   token. That token maps to the business; the Revolut tokens never leave the server.

The Revolut `client_id` is the tenant key. It is safe as an identity because Revolut only ever
issues a consent for it to someone signed into that business.

## Tools

| Scope | Tools |
| --- | --- |
| connection *(hosted)* | `get_connection_status` |
| auth *(stdio)* | `setup_auth`, `complete_auth` |
| accounts | `get_accounts`, `get_account`, `get_account_bank_details` |
| transactions | `get_transactions`, `get_transaction` |
| counterparties | `get_counterparties`, `get_counterparty`, `create_counterparty`, `delete_counterparty` |
| payments | `get_payment_drafts`, `get_transfer_reasons`, `create_payment`, `transfer_between_accounts`, `cancel_transaction` |
| foreign exchange | `get_exchange_rate`, `exchange_currency` |
| team | `get_team_members` |
| sandbox *(sandbox connections only)* | `simulate_topup`, `simulate_transaction_state` |

Write tools are exposed unconditionally, but the real gate is Revolut's own consent screen: a
business that grants read-only gets HTTP 403 from anything that moves money. The sandbox simulators
are not even listed on a production connection.

## Running over stdio

```bash
npm install
npm run build
```

Generate a keypair and register it in your Revolut portal, with any public HTTPS redirect URI
(Revolut rejects `localhost`; you only ever copy the `code` out of it):

```bash
openssl genrsa -out certs/privatekey.pem 2048
openssl req -new -x509 -key certs/privatekey.pem -out certs/publickey.cer -days 1825 \
  -subj "/CN=revolut-mcp"
```

| Variable | Required | Description |
| --- | --- | --- |
| `REVOLUT_CLIENT_ID` | yes | Client ID from the Revolut Business portal. |
| `REVOLUT_PRIVATE_KEY_PATH` | one of | Path to the PEM private key that signs the JWT. |
| `REVOLUT_PRIVATE_KEY` | one of | PEM contents instead of a path (handy in containers). |
| `REVOLUT_REDIRECT_URI` | no | The URI registered with the certificate. Default `https://example.com/`. |
| `REVOLUT_JWT_ISS` | no | JWT issuer. Defaults to the redirect URI's host, which is what Revolut requires. |
| `TOKEN_STORE_PATH` | no | Where tokens are persisted. Default `./.tokens.json`. |
| `REVOLUT_ENVIRONMENT` | no | `sandbox` (default) or `production`. |

```bash
claude mcp add revolut \
  --env REVOLUT_CLIENT_ID=your_client_id \
  --env REVOLUT_PRIVATE_KEY_PATH=/absolute/path/to/certs/privatekey.pem \
  --env REVOLUT_REDIRECT_URI=https://example.com/ \
  --env REVOLUT_ENVIRONMENT=production \
  -- node /absolute/path/to/revolut-mcp/dist/index.js
```

Then ask the assistant to call `setup_auth`, open the URL it returns, approve, and pass the `code`
from the redirect to `complete_auth`. Tokens land in `TOKEN_STORE_PATH` and refresh themselves.

## Running hosted (multi-tenant)

```bash
npm run build
npm run start:http     # or: node dist/index.js --http
```

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_TRANSPORT` | — | Set to `http` instead of passing `--http`. |
| `PORT` | `80` | Port to listen on. |
| `HOST` | `::` | Interface to bind (dual-stack; falls back to IPv4 if IPv6 is unavailable). |
| `PUBLIC_BASE_URL` | — | **Required in practice.** This deployment's public origin. The JWT `iss` claim is derived from its host and must match what every business registered, so it cannot be guessed per request. |
| `MCP_PATH` | `/mcp` | Path the MCP endpoint is mounted at. |
| `DATABASE_URL` | — | Postgres. Holds tenants, OAuth clients, codes and tokens. |
| `REVOLUT_SESSION_KEY` | — | 32 bytes as 64 hex chars. Encrypts stored Revolut tokens (AES-256-GCM). |
| `REVOLUT_SERVICE_PRIVATE_KEY` | — | PEM private key that signs every tenant's client assertion. |
| `REVOLUT_SERVICE_CERTIFICATE` | — | PEM X.509 certificate businesses register with Revolut. |

Without the last four, the server still starts and serves `/health` and the discovery endpoints —
it just refuses MCP requests, and `/health` reports `"hosted": false`, so a misconfigured deployment
is obvious rather than silently broken.

### Endpoints

| Path | Purpose |
| --- | --- |
| `/mcp` | Streamable-HTTP MCP endpoint. Bearer token required. |
| `/health` | Status, version, build commit, and whether hosted mode came up. |
| `/.well-known/oauth-authorization-server` | RFC 8414 metadata. |
| `/.well-known/oauth-protected-resource[/mcp]` | RFC 9728 metadata. |
| `/register` | RFC 7591 dynamic client registration. |
| `/authorize` | The connect page (GET) and its submit (POST). |
| `/revolut/callback` | Where Revolut returns after consent. |
| `/token`, `/revoke` | Token grants and RFC 7009 revocation. |
| `/certificate.pem` | The certificate businesses register. Public by design. |

### What is stored

Only what is needed to keep the connection alive: the Revolut `client_id`, which environment it
targets, an optional display label, and the access + refresh tokens — encrypted at rest with
`REVOLUT_SESSION_KEY`. OAuth codes and bearer tokens are stored as SHA-256 hashes, so a database
leak yields nothing usable. No Revolut password ever reaches the server; the business authenticates
on Revolut's own site.

## Hosting your own

The deployment here targets [Pironman](https://revolut-mcp-coolify.bogdanripa.com) — a Raspberry Pi
5 running Coolify — but nothing is specific to it beyond `.github/workflows/deploy.yml`. The image
is a plain arm64 Node container listening on port 80 with a `/health` check, plus a Postgres
database and a static site in `web/`.

1. Create the app and attach a Postgres database; put its scoped deploy key in the repo as
   `PAAS_KEY`.
2. Generate the service keypair (`openssl genrsa` + `openssl req -x509`, as above, with your own
   hostname as the CN).
3. Set `REVOLUT_SERVICE_PRIVATE_KEY`, `REVOLUT_SERVICE_CERTIFICATE`, `REVOLUT_SESSION_KEY`
   (`openssl rand -hex 32`) and `PUBLIC_BASE_URL` on the app.
4. Push. CI builds the arm64 image, deploys it, uploads `web/` to the CDN, and smoke-tests the whole
   OAuth surface against the live host.

Rotating the service keypair invalidates every connected business — they each registered the old
certificate — so treat it as a migration, not a routine operation.

## Development

```bash
npm test          # unit + HTTP round-trip suite
npm run typecheck
npm run build
```

The suite covers the OAuth authorization server, the Revolut link round-trip, token encryption, and
an end-to-end HTTP walk from dynamic client registration through to an authenticated MCP
`initialize`. Revolut itself is stubbed through an injected axios instance, so no test touches the
network. Integration tests against a real sandbox account are env-gated:

```bash
REVOLUT_RUN_INTEGRATION=1 npm run test:integration
```

## Docs

- [`docs/`](docs/) — per-scope tool reference and worked examples.
- [`web/`](web/) — the marketing site and setup guide published with each deploy.

## Licence

MIT. Originally based on [jeff-nasseri/revolut-mcp](https://github.com/jeff-nasseri/revolut-mcp),
rebuilt around a multi-tenant hosted transport.
