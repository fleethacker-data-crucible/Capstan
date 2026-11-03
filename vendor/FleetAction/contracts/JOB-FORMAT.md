# FleetAction job format

Version 1. Jobs are JSON only. YAML, PSD1, XML, and JSON with comments are not jobs.

The normative schema is `job.schema.json` (JSON Schema draft-07), schema id `https://github.com/fleethacker-data-crucible/fleet-action-baseline/contracts/job.schema.json`.

```json
{
  "version": 1,
  "steps": [
    {
      "id": "fetch",
      "app": "widget",
      "noun": "item",
      "verb": "get",
      "args": { "id": "item-1" }
    },
    {
      "id": "rename",
      "app": "widget",
      "noun": "item",
      "verb": "label",
      "args": {
        "id": "${steps.fetch.result.id}",
        "name": "bolt"
      }
    }
  ]
}
```

`version` MUST be the integer `1`. `steps` has from 1 to 100 objects. Step `id` values are unique and match `^[A-Za-z][A-Za-z0-9_-]{0,63}$`. `app`, `noun`, and `verb` are the action id parts. `confirmed` is an optional boolean. `args` is an optional object of scalar values.

## Substitution

The only substitution is the exact token `${steps.<id>.result.<field>}`.

- Replacement is a literal string operation. The runner does not expand PowerShell strings and does not evaluate expressions.
- `<id>` is an earlier step that succeeded. `<field>` is one property name, not a dotted path.
- When the whole argument equals one token, the typed scalar is kept (a number stays a number).
- When the token is embedded in a longer string, the field is inserted as text.
- The referenced field must exist and must be a scalar. A missing step, a missing field, or a non-scalar field is `E_ARGS`.
- Tokens are replaced only inside `args` string values. `id`, `app`, `noun`, and `verb` are never rewritten.
- Any other `$`, backticks, or parentheses are ordinary characters.

## Confirmation

A destructive step runs only when the step has `"confirmed": true` or the caller passed `--yes` / `-Confirmed` / API `"confirmed": true`. Otherwise the job stops with `E_CONFIRM` and does not call that handler or any later step.

## Dry-run

`--dry-run` validates every step it reaches, resolves substitution against earlier dry-run results, and does not call handlers. A dry-run result only has the fields listed in `CLI-CONTRACT.md`. A later step that needs a handler field fails with `E_ARGS` because that field does not exist yet. Destructive steps do not require confirmation during dry-run. `confirmationRequired` reports that a real run would.

## Partial failure

Steps run in order. The first failure stops the job. Later steps do not run. The envelope is `ok: false` with `error` and no top-level `result`:

```json
{
  "v": 1,
  "ok": false,
  "error": {
    "code": "E_NOT_FOUND",
    "message": "Step 'missing' failed. Action is not registered.",
    "stepId": "missing",
    "completed": [
      { "id": "fetch", "ok": true, "result": { "id": "item-1", "name": "sample" } }
    ]
  }
}
```

`completed` lists only the steps that finished. `error.code` is the failing step's code. `E_INTERNAL` still uses the generic message, prefixed with the step id sentence.

## Stable identifiers

Action ids inside steps are `app.noun.verb`. Entity ids travel in `result.id` and match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` when a handler returns one. Substitution copies that value; it does not assign a new one.

## Limits

The job file is at most 1 MiB. Argument strings are at most 65536 characters. These are the same caps as the HTTP body.
