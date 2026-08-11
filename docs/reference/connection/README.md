### Connection

Inspect which Revolut Business account this connection is bound to.

This scope replaces [Auth](../auth/README.md) on a **hosted** connection. There, the business
authorized in a browser long before the model was involved, so there is nothing for it to do about
authentication — only something to know.

#### `get_connection_status`
Reports which Revolut Business account this connection is authorized for, which environment it
targets (production or sandbox), when it was connected, and which permissions the business granted.
- Parameters: None
- Example:
  ```
  get_connection_status()
  ```
- Example output:
  ```
  Environment : production
  Business    : Acme SRL EUR
  Connected   : 2026-08-11
  Permissions : READ
  ```

Reach for it when a call comes back with HTTP 403: that means the business did not grant that
capability on Revolut's consent screen, and this says what it did grant. Reconnecting from the
assistant and ticking the missing permission is the fix — the server cannot widen a consent on its
own.
