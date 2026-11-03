# FleetAction threat model

Version 1.0.0. This describes what the session token and the confirmation flag actually mean.

## Assets

- The per-session token. Possession of the token is permission to call every action on that listener, including destructive ones.
- Files and other state the actions mutate.
- The operator's local account. The listener runs as the current user, with no admin rights and no service install.

## Boundaries

The listener accepts TCP connections only on `127.0.0.1`. That is not enough. A browser on the same machine will happily talk to loopback, so a page loaded from anywhere can attempt a loopback request (CSRF), and a DNS-rebinding name can point at `127.0.0.1` while the `Host` header still carries the attacker's name.

Controls, in order, before the body is read:

1. `Host` must be the literal loopback name and port.
2. `Origin` must be `http://127.0.0.1:<port>` on API calls.
3. The bearer token or the `HttpOnly` `SameSite=Strict` cookie must match the session token.

The body is capped at 1 MiB, chunked encoding is rejected, and unknown lengths are rejected so a client cannot stream an unbounded request into the process.

## What the token is

The token is **full authority** for the life of the process. It is not a scope, not a role, and not a per-action grant. Anyone who can read the token can do anything the actions can do.

The file `%LOCALAPPDATA%\FleetHacker\<app>\session.token` is created with an explicit current-user ACL before the secret is written. On Windows the contents are also DPAPI-protected for the current user when that API exists. A new token is generated every time the server starts. The file is deleted when the server shuts down. Logs, verbose messages, discovery payloads, the port probe, and GUI source do not contain the token. The GUI receives it only through the `HttpOnly` cookie described in `API-CONTRACT.md`, never through the DOM or a script-visible store.

## What `--yes` is

`--yes` and `-Confirmed` are an **accident guard**. They stop a person, or a half-written command, from firing a destructive action. They do not authenticate the caller. A client that already has the token can send `"confirmed": true`. Human confirmation on the server, with a person at the console for every destructive call, is a later version. Version 1.0.0 does not implement that gate.

A destructive call without confirmation returns `409` / exit `4` / `E_CONFIRM` and does not run the handler. Dry-run does not mutate state and does not require the flag. It reports `confirmationRequired` so the operator can see the guard would trip.

## Jobs

Job substitution is a straight text replace of `${steps.<id>.result.<field>}`. The runner never evaluates the job as code. A job file is untrusted input. Unknown actions, unknown arguments, non-scalar arguments, and schema failures fail closed with `E_ARGS` or `E_NOT_FOUND`.

## Logs

Verbose and error text are redacted for bearer values and for `token`, `secret`, `password`, `authorization`, and `cookie` assignments. Handlers should not write secrets to the success payload if that payload is displayed. `E_INTERNAL` does not echo the exception text.

## Out of scope for 1.0.0

- Remote or LAN clients.
- Per-action authorization scopes.
- A server-side human approval queue.
- Protecting a user who already has the token from themselves, beyond the accident guard.
- Multi-user machines where two people share one Windows profile. The ACL is current-user, so the profile owner can read the file.
