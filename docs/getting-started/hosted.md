# Hosted mode (multi-tenant)

The same server runs as a hosted, multi-business service: one deployment, any number of Revolut
Business accounts, each connecting for itself in a browser. This is the mode the public deployment
at <https://revolut-mcp-coolify.bogdanripa.com/> runs in.

Nothing about a business is configured on the server. It arrives during the connect flow and is
stored against that business alone.

---

## Connecting as a business

You need a Revolut Business account and access to **Settings → APIs** on it (Owner or Admin).

1. **Add the connector.** In Claude: Settings → Connectors → *Add custom connector* → paste
   `https://revolut-mcp-coolify.bogdanripa.com/mcp`. Leave client ID and secret empty; the server
   registers the client itself (RFC 7591). Any MCP client that speaks streamable HTTP and OAuth
   works the same way.

2. **Register the certificate.** Your assistant sends you to the connect page. It shows this
   deployment's public X.509 certificate and the redirect URI, both with copy buttons, and
   deep-links to your Revolut API settings. In Revolut, click *Add API certificate* and paste:

   | Revolut field | Value |
   | --- | --- |
   | X509 public key | the certificate from the connect page (also at `/certificate.pem`) |
   | OAuth redirect URI | `https://revolut-mcp-coolify.bogdanripa.com/revolut/callback` |

   The redirect URI must match **exactly**, path included. Revolut also asks which permissions to
   grant: *Read your account details* is required; the payment permissions are optional and are the
   only thing that lets the assistant move money.

3. **Paste the Client ID.** Revolut shows one next to the new certificate. Paste it into the connect
   page and continue.

4. **Approve.** You land on Revolut's own consent screen. Approve, and you are sent back. If Revolut
   inserts an identity re-verification step ending in *"Successfully authorized — please return to
   your original tab"*, switch back to the tab you started in.

The server reads your account list before reporting success, so a consent with no usable permissions
fails immediately and visibly rather than later inside a tool call.

### Why is step 2 manual?

Revolut Business has no API for creating an API client — every business creates its own, in its own
portal, and the certificate is what proves the connection belongs to it. There is no way to automate
that from the outside without asking for a Revolut password, which this server deliberately never
does.

### Keeping it connected

Access tokens last ~40 minutes and refresh automatically. The consent behind them lasts about **90
days**, and the certificate has its own expiry. When either lapses, reconnect from your assistant:
the same Client ID still works, so only the approval is repeated.

To disconnect, revoke the connector in your assistant, and delete the API certificate in Revolut to
cut access at the source.

---

## Running your own deployment

### Environment

| Variable | Description |
| --- | --- |
| `MCP_TRANSPORT=http` | Or pass `--http`. |
| `PUBLIC_BASE_URL` | The deployment's public origin. **Effectively required:** the JWT `iss` claim is derived from its host and must equal what every business registered, so it cannot be inferred per request. |
| `DATABASE_URL` | Postgres. Tables are created on startup. |
| `REVOLUT_SESSION_KEY` | 32 bytes as 64 hex chars (`openssl rand -hex 32`). Encrypts stored Revolut tokens. |
| `REVOLUT_SERVICE_PRIVATE_KEY` | PEM private key signing every tenant's client assertion. |
| `REVOLUT_SERVICE_CERTIFICATE` | PEM X.509 certificate businesses register. |
| `PORT` | Default `80`. |
| `HOST` | Default `::` (dual-stack). |
| `MCP_PATH` | Default `/mcp`. |

Generate the service keypair with the deployment's own hostname:

```bash
openssl genrsa -out privatekey.pem 2048
openssl req -new -x509 -key privatekey.pem -out publickey.cer -days 1825 \
  -subj "/CN=your-host.example.com/O=revolut-mcp"
```

Every business registers the **same** public certificate; only the private half is secret. Rotating
the pair invalidates every connected business, since each registered the old certificate — treat it
as a migration.

### What is stored

| Table | Contents |
| --- | --- |
| `tenants` | Revolut `client_id`, environment, display label, and the access + refresh tokens encrypted with `REVOLUT_SESSION_KEY` (AES-256-GCM). |
| `oauth_clients` | MCP clients registered via DCR. |
| `oauth_links` | In-flight connect attempts, while the business is at Revolut's consent screen. Single-use, 30-minute TTL. |
| `oauth_codes` | Authorization codes, SHA-256 hashed. Single-use, 5-minute TTL. |
| `oauth_tokens` | Bearer and refresh tokens, SHA-256 hashed. |

No Revolut password is ever seen, and no raw code or bearer token is ever written to the database.

### Health and diagnosis

`GET /health` returns the version, the commit the image was built from, and `hosted`, which is
`false` when the tenant store or service certificate failed to come up. In that state the server
still serves pages and discovery metadata but refuses MCP requests with `503 oauth_unavailable` —
the failure is loud rather than silent.

### Deployment

`.github/workflows/deploy.yml` builds a linux/arm64 image, deploys it, uploads `web/` to the static
host, and then smoke-tests the live deployment: health commit match, hosted mode enabled, the
homepage served as static HTML, the certificate endpoint, both discovery documents pointing at the
public host, a 401 challenge naming the resource metadata, and a full dynamic-registration walk to
a rendered connect page.

---

## Security notes

- The MCP client never receives a Revolut token — only a bearer token that maps to the business and
  can be revoked here without touching Revolut.
- The tenant key is the Revolut `client_id`. Revolut only issues a consent for it to someone signed
  into that business, so it cannot be used to reach another business's data.
- The connect attempt is carried across the Revolut round-trip by both a `state` parameter and a
  `SameSite=Lax` `HttpOnly` cookie, so the flow survives an authorization server that does not echo
  `state`.
- PKCE with `S256` is mandatory; `plain` is rejected.
- Write tools are exposed, but Revolut's consent screen is the real gate: a read-only grant makes
  every money-moving call fail with HTTP 403.
