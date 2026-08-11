// The /authorize connect screen.
//
// Revolut Business has no API for creating an API certificate, so one manual
// step is unavoidable: the business registers our public certificate in its own
// portal and gets a Client ID back. Everything else is driven for them — this
// page carries the OAuth request through as hidden fields, deep-links straight
// to the right Revolut settings page, and hands both values they need to paste
// over on a single click. After they submit the Client ID they never type
// anything again: the browser goes to Revolut's consent screen and comes back.

const FIELDS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'scope',
  'state',
  'code_challenge',
  'code_challenge_method',
  'resource',
] as const;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface ConnectPageOptions {
  /** OAuth request parameters to preserve across the POST, as raw strings. */
  params: Record<string, string | undefined>;
  /** The requesting MCP client's display name, if it registered one. */
  clientName?: string;
  /** The deployment's public X.509 certificate, PEM. */
  certificate: string;
  /** The redirect URI every business registers alongside the certificate. */
  redirectUri: string;
  /** An error to show above the form. */
  error?: string;
  /** A second line under the error saying what to do about it. */
  hint?: string;
  /** Values to re-fill the form with after an error. */
  values?: { revolutClientId?: string; environment?: string };
}

const STYLE = `
  :root {
    --bg:#f6f7f9; --panel:#ffffff; --fg:#16191d; --muted:#5b6470; --line:#e2e6ea;
    --accent:#1f6feb; --accent-fg:#ffffff; --code:#f2f4f7;
    --warn-bg:#fff8e6; --warn-line:#f0d38a; --warn-fg:#6b4e00;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#0f1216; --panel:#171b21; --fg:#e8eaed; --muted:#9aa4b2; --line:#2a313a;
      --accent:#4c8dff; --accent-fg:#06101f; --code:#11151a;
      --warn-bg:#2a2313; --warn-line:#5c4a1a; --warn-fg:#f2d492;
    }
  }
  * { box-sizing:border-box; }
  body { margin:0; padding:2.5rem 1rem 4rem; background:var(--bg); color:var(--fg);
    font:16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { max-width:34rem; margin:0 auto; }
  h1 { font-size:1.5rem; margin:0 0 .35rem; letter-spacing:-.02em; }
  .lede { color:var(--muted); font-size:.95rem; margin:0 0 1.75rem; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:12px;
    padding:1.25rem; margin-bottom:1rem; }
  .step { display:flex; gap:.65rem; align-items:baseline; margin:0 0 .75rem; }
  .step .n { flex:none; width:1.55rem; height:1.55rem; border-radius:50%; background:var(--accent);
    color:var(--accent-fg); font-weight:700; font-size:.8rem; display:inline-flex;
    align-items:center; justify-content:center; align-self:flex-start; }
  .step h2 { font-size:1rem; margin:0; letter-spacing:-.01em; }
  .step p { margin:.15rem 0 0; color:var(--muted); font-size:.9rem; }
  .indent { padding-left:2.2rem; }
  label { display:block; font-weight:600; font-size:.8rem; margin:0 0 .3rem; }
  .hintline { color:var(--muted); font-size:.82rem; margin:.35rem 0 0; }
  .copy { display:flex; gap:.5rem; align-items:flex-start; background:var(--code);
    border:1px solid var(--line); border-radius:9px; padding:.55rem .6rem; margin-bottom:1rem; }
  .copy code, .copy pre { flex:1; margin:0; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size:.8rem; color:var(--fg); word-break:break-all; white-space:pre-wrap; background:none;
    max-height:6.5rem; overflow:auto; }
  input[type=text] { width:100%; padding:.6rem .7rem; background:var(--bg); color:var(--fg);
    border:1px solid var(--line); border-radius:8px; font:inherit; font-size:.95rem;
    font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  input:focus { outline:2px solid var(--accent); outline-offset:1px; border-color:transparent; }
  button, .btn { border:0; border-radius:8px; background:var(--accent); color:var(--accent-fg);
    font:inherit; font-size:.9rem; font-weight:600; padding:.45rem .8rem; cursor:pointer;
    white-space:nowrap; text-decoration:none; display:inline-flex; align-items:center;
    justify-content:center; gap:.45em; }
  button:hover, .btn:hover { filter:brightness(1.08); }
  button.ghost { background:transparent; color:var(--accent); border:1px solid var(--line); }
  button.submit { width:100%; padding:.7rem 1.1rem; font-size:1rem; margin-top:1.25rem; }
  button.loading { opacity:.75; cursor:default; }
  .spin { display:none; width:1em; height:1em; border:2px solid currentColor;
    border-right-color:transparent; border-radius:50%; animation:spin .6s linear infinite; }
  button.loading .spin { display:inline-block; }
  @keyframes spin { to { transform:rotate(360deg); } }
  .seg { display:inline-flex; border:1px solid var(--line); border-radius:8px; overflow:hidden;
    margin-bottom:1.1rem; }
  .seg label { margin:0; font-weight:600; font-size:.85rem; }
  .seg input { position:absolute; opacity:0; pointer-events:none; }
  .seg span { display:block; padding:.4rem .9rem; cursor:pointer; color:var(--muted); }
  .seg input:checked + span { background:var(--accent); color:var(--accent-fg); }
  .error { background:#fdecea; border:1px solid #f5c6cb; color:#a1201a; border-radius:9px;
    padding:.7rem .85rem; font-size:.88rem; margin-bottom:1.25rem; }
  .error strong { display:block; }
  .error span { color:inherit; opacity:.85; }
  @media (prefers-color-scheme: dark) {
    .error { background:#3a1d1d; border-color:#5c2a2a; color:#ff9b93; }
  }
  .warn { background:var(--warn-bg); border:1px solid var(--warn-line); color:var(--warn-fg);
    border-radius:10px; padding:.75rem .9rem; font-size:.83rem; }
  .warn p { margin:0; color:inherit; }
  a { color:var(--accent); }
`;

const PORTALS = {
  production: 'https://business.revolut.com/settings/api',
  sandbox: 'https://sandbox-business.revolut.com/settings/api',
} as const;

export function renderConnectPage(options: ConnectPageOptions): string {
  const { params, clientName, certificate, redirectUri, error, hint, values } = options;

  const hidden = FIELDS.map((name) => {
    const value = params[name];
    return value === undefined ? '' : `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  }).join('\n      ');

  const who = clientName ? `<strong>${escapeHtml(clientName)}</strong>` : 'Your assistant';
  const env = values?.environment === 'sandbox' ? 'sandbox' : 'production';
  const clientIdValue = values?.revolutClientId ? escapeHtml(values.revolutClientId) : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect Revolut Business</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>Connect your Revolut Business account</h1>
  <p class="lede">${who} wants to read and act on your Revolut Business account.
    This takes about a minute, once.</p>

  ${
    error
      ? `<div class="error"><strong>${escapeHtml(error)}</strong>${
          hint ? `<span>${escapeHtml(hint)}</span>` : ''
        }</div>`
      : ''
  }

  <form method="post" action="/authorize" id="connect">
      ${hidden}

    <div class="panel">
      <div class="step"><span class="n">1</span><div>
        <h2>Pick your Revolut environment</h2>
        <p>Use Production unless you were specifically given a sandbox account.</p>
      </div></div>
      <div class="indent">
        <div class="seg">
          <label><input type="radio" name="environment" value="production" ${
            env === 'production' ? 'checked' : ''
          }><span>Production</span></label>
          <label><input type="radio" name="environment" value="sandbox" ${
            env === 'sandbox' ? 'checked' : ''
          }><span>Sandbox</span></label>
        </div>
      </div>

      <div class="step"><span class="n">2</span><div>
        <h2>Add our certificate in Revolut</h2>
        <p>Open your API settings and click <em>Add API certificate</em>. Paste these two values into
          the form there, then save.</p>
      </div></div>
      <div class="indent">
        <p><a class="btn" id="portal" href="${PORTALS.production}" target="_blank" rel="noopener noreferrer">
          Open Revolut API settings ↗</a></p>

        <label for="cert">X509 public key — paste into the big box</label>
        <div class="copy">
          <pre id="cert">${escapeHtml(certificate.trim())}</pre>
          <button type="button" class="ghost" data-copy="cert">Copy</button>
        </div>

        <label for="uri">OAuth redirect URI — paste into the small box</label>
        <div class="copy">
          <code id="uri">${escapeHtml(redirectUri)}</code>
          <button type="button" class="ghost" data-copy="uri">Copy</button>
        </div>
        <p class="hintline">Revolut will also ask which permissions to grant. Tick at least
          <em>Read your account details</em>; add the payment permissions only if you want your
          assistant to be able to move money.</p>
      </div>

      <div class="step"><span class="n">3</span><div>
        <h2>Paste the Client ID Revolut gives you</h2>
        <p>After saving, Revolut shows a <em>Client ID</em> next to your new certificate.</p>
      </div></div>
      <div class="indent">
        <label for="revolut_client_id">Client ID</label>
        <input id="revolut_client_id" name="revolut_client_id" type="text" required
          autocomplete="off" spellcheck="false" autocapitalize="off"
          placeholder="e.g. J3lPq0Xm2FhK8w..." value="${clientIdValue}">
      </div>

      <button class="submit" id="submit" type="submit">
        <span class="spin" aria-hidden="true"></span><span class="label">Continue to Revolut</span>
      </button>
    </div>
  </form>

  <div class="warn">
    <p>Revolut asks you to approve the connection on its own site — your Revolut password never
      touches this server. We store only the access token Revolut issues, encrypted, and
      ${who === 'Your assistant' ? 'your assistant' : 'the application'} receives a separate,
      revocable token that we can cut off at any time.</p>
  </div>
</main>
<script>
(function () {
  // Keep the "open Revolut" deep link pointed at whichever portal is selected.
  var portals = ${JSON.stringify(PORTALS)};
  var link = document.getElementById('portal');
  function sync() {
    var picked = document.querySelector('input[name=environment]:checked');
    link.href = portals[picked && picked.value === 'sandbox' ? 'sandbox' : 'production'];
  }
  Array.prototype.forEach.call(document.querySelectorAll('input[name=environment]'), function (input) {
    input.addEventListener('change', sync);
  });
  sync();

  Array.prototype.forEach.call(document.querySelectorAll('[data-copy]'), function (btn) {
    btn.addEventListener('click', function () {
      var text = document.getElementById(btn.getAttribute('data-copy')).textContent;
      var done = function () {
        btn.textContent = 'Copied';
        setTimeout(function () { btn.textContent = 'Copy'; }, 1500);
      };
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, done);
      else {
        var area = document.createElement('textarea');
        area.value = text; document.body.appendChild(area); area.select();
        document.execCommand('copy'); document.body.removeChild(area); done();
      }
    });
  });

  var form = document.getElementById('connect');
  var submit = document.getElementById('submit');
  form.addEventListener('submit', function () {
    submit.classList.add('loading');
    var label = submit.querySelector('.label');
    if (label) label.textContent = 'Contacting Revolut…';
    setTimeout(function () { submit.disabled = true; }, 0);
  });
})();
</script>
</body>
</html>`;
}

export interface NoticePageOptions {
  title: string;
  message: string;
  hint?: string;
  /** When set, renders a button that restarts the flow. */
  retryUrl?: string;
}

/** A standalone message page — used for a failed link and for invalid OAuth requests. */
export function renderNoticePage({ title, message, hint, retryUrl }: NoticePageOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>${escapeHtml(title)}</h1>
  <p class="lede">${escapeHtml(message)}</p>
  <div class="panel">
    <p style="margin:0;font-size:.92rem;">${hint ? escapeHtml(hint) : 'You can close this tab.'}</p>
    ${retryUrl ? `<p style="margin:1rem 0 0"><a class="btn" href="${escapeHtml(retryUrl)}">Try again</a></p>` : ''}
  </div>
</main>
</body>
</html>`;
}
