# FleetAction HTTP contract

Version 1.0.0. The listener binds exactly `http://127.0.0.1:<port>/`. It never binds `+`, `*`, `0.0.0.0`, or a LAN address.

## Routes

| Method | Path | Auth | Body |
| --- | --- | --- | --- |
| `GET` | `/__fleethacker/id` | Host only | none |
| `GET` | `/` | Host. Origin must match when it is present. | none |
| `GET` | `/api/v1/actions` | Host, Origin, bearer | none |
| `POST` | `/api/v1/job` | Host, Origin, bearer | JSON job |
| `POST` | `/api/v1/<app>/<noun>/<verb>` | Host, Origin, bearer | JSON |

`<app>`, `<noun>`, and `<verb>` are the action id parts. The URL app must be the app that owns the listener. Any other path is `404` `E_NOT_FOUND`. A query string is `E_ARGS`.

`GET /__fleethacker/id` is the port probe. The body is the result envelope:

```json
{
  "v": 1,
  "ok": true,
  "result": {
    "app": "widget",
    "id": "widget",
    "framework": "FleetAction",
    "frameworkVersion": "1.0.0"
  }
}
```

The probe does not return the session token.

`GET /` returns a tiny HTML page and sets the session cookie. The HTML does not contain the token.

## Check order

Every API request is checked in this order, and the body is not read until all three pass:

1. **Host.** The `Host` header must be `127.0.0.1` or `127.0.0.1:<port>`. `localhost`, a DNS-rebinding name such as `127.0.0.1.evil.com`, the wrong port, and an empty host are rejected with `401` `E_AUTH` and the message `Host is not allowed.`
2. **Origin.** API routes require `Origin: http://127.0.0.1:<port>` with no path and no trailing slash. Anything else, including a missing Origin, is `401` `E_AUTH` and the message `Origin is not allowed.`
3. **Bearer token.** `Authorization: Bearer <token>` must match the session token. Comparison is byte-wise over the full length. A mismatch is `401` `E_AUTH` and the message `Bearer token is not valid.`

The first failing check is the one reported. A bad Host wins over a bad Origin, a bad token, and a bad body.

`GET /__fleethacker/id` stops after the Host check. `GET /` stops after the Host check and, when Origin is present, the Origin check. It does not require a bearer token because that response is what delivers the cookie.

## Cookie injection

Browsers authenticate with an `HttpOnly` cookie so page scripts never see the token:

```text
Set-Cookie: FleetSession=<token>; HttpOnly; SameSite=Strict; Path=/
```

The cookie is set on `GET /` only. Scripts call `fetch` with `credentials: 'same-origin'` and do not set `Authorization`. If `Authorization` is present, it is the credential that is checked and the cookie is ignored.

The token is full authority for every action on that listener. See `SECURITY.md`.

## Body limits

For `POST`:

- `Transfer-Encoding: chunked` is rejected with `400` `E_ARGS` and the body is not read.
- A missing or negative `Content-Length` is rejected the same way.
- `Content-Length` greater than `1048576` (1 MiB) is rejected before the body is read.
- The read is capped at `Content-Length` and at 1 MiB, whichever is smaller.

`POST /api/v1/<app>/<noun>/<verb>` accepts:

```json
{ "args": { "id": "item-1" }, "confirmed": false, "dryRun": false }
```

Only `args`, `confirmed`, and `dryRun` are allowed. Argument values must be JSON scalars (`string`, `number`, `boolean`, or `null`). Strings are at most 65536 characters. At most 32 arguments are allowed.

`POST /api/v1/job` accepts a version 1 job. Optional siblings `confirmed` and `dryRun` are taken off the document before schema validation. `confirmed: true` confirms every destructive step.

## Status codes

| HTTP | Exit analogue | Code |
| --- | --- | --- |
| 200 | 0 | success |
| 400 | 2 | `E_ARGS` |
| 404 | 3 | `E_NOT_FOUND` |
| 409 | 4 | `E_CONFIRM` |
| 401 | 5 | `E_AUTH` |
| 500 | 1 | `E_INTERNAL` |

`E_INTERNAL` uses the message `An internal error occurred.` The response is JSON, `Content-Type: application/json; charset=utf-8`, UTF-8 without a byte-order mark, except `GET /`, which is `text/html; charset=utf-8`.

`Response.Close()` runs in a `finally` block for every accepted context.

## Session token file

The listener writes `%LOCALAPPDATA%\FleetHacker\<app>\session.token`.

- A new token is generated for each server start (session rotation).
- The file is created empty, then an explicit current-user ACL is applied, and only then are the secret bytes written.
- On Windows the bytes are DPAPI-protected for `CurrentUser` when that API is available. The ACL is still applied.
- The file is deleted when the server stops or the process leaves the listen loop.
- The file mode on non-Windows hosts is owner read/write.

The in-memory copy is the value compared to the bearer token. Logs never include it.

## Stable identifiers

Discovery and `GET /api/v1/actions` list action ids `app.noun.verb`. Entity ids returned by handlers use the pattern in `CLI-CONTRACT.md`. The probe result `id` is the app name, which is the stable id of that listener.
