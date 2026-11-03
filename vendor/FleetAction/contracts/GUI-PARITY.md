# FleetAction GUI parity

Version 1.0.0. A Fleet GUI is a Chrome-engine page served from the local app. These rules are mandatory for any page that invokes an action. `tests/Conformance.Tests.ps1` fails the build when a scanned GUI file breaks them.

Scan scope is the `gui` directory next to the CLI entry, or the path in `FLEET_GUI`.

## 1. `data-action` only on a native button or link

Every `data-action` attribute sits on a `<button>` or an `<a>`. Divs, spans, and inputs are not action targets. In script files the substring `data-action` may appear only as `[data-action]` or as `getAttribute('data-action')`.

## 2. `aria-busy` and `aria-disabled`

The control that started the action sets `aria-busy="true"` and `aria-disabled="true"` while the call is in flight, and sets both back to `false` when it finishes. Both attribute names appear in the GUI source.

## 3. Status and alert announcements

The page has a status region (`role="status"` or `aria-live="polite"`) and an alert region (`role="alert"` or `aria-live="assertive"`). Progress text goes to the status region. Failures go to the alert region.

## 4. Native confirm dialog, Cancel by default

Destructive actions open a native `<dialog>` before anything is sent. The Cancel button is the default: it carries `autofocus`, and the continue button does not. `window.confirm`, `window.alert`, and `window.prompt` are not used. `confirm(` is not used. Closing the dialog with Cancel, or dismissing it, does not call the action.

## 5. Readable errors

The alert text is the envelope's human message (`error.message`), not the bare code and not a stack trace.

## 6. The token never enters the DOM

Pages do not contain the session token, the word `Bearer`, an `Authorization` header, `FleetSession`, `session.token`, or `document.cookie`. Scripts do not read the cookie. The host injects the session with the `HttpOnly` cookie from `GET /`, and `fetch` uses `credentials: 'same-origin'`.

## 7. 32px targets

`button` and link targets declare `min-height: 32px` and `min-width: 32px`.

## Token injection without the DOM

The PowerShell host opens `http://127.0.0.1:<port>/`. The listener's response sets `Set-Cookie: FleetSession=...; HttpOnly; SameSite=Strict; Path=/`. The HTML body of that response does not include the token. Later `fetch` calls to `/api/v1/...` send the cookie automatically. Scripts never copy it into a variable, a data attribute, `localStorage`, or the document.

## Action ids

`data-action` values are the stable action id `app.noun.verb`.
