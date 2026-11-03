# FleetAction CLI contract

Version 1.0.0. This file is normative for every Fleet app CLI.

The grammar is:

```text
<app> commands [--json] [--out <file>]
<app> help [--json] [--out <file>]
<app> <noun> <verb> [--<arg> <value>]... [--json] [--out <file>] [--yes] [--dry-run]
<app> job run --file <job.json> [--json] [--out <file>] [--yes] [--dry-run]
```

`<app>`, `<noun>`, and `<verb>` match `^[a-z][a-z0-9-]{0,62}$`. The nouns `commands`, `help`, and `job` are reserved.

## Discovery

Discovery is `<app> commands --json`. `<app> help --json` is an alias and MUST emit the same JSON envelope and the same action list. The HTTP discovery route is `GET /api/v1/actions` and is not renamed.

Without `--json`, `commands` and `help` print a short text list on stdout.

## Flags

| Flag | Meaning |
| --- | --- |
| `--json` | Write the result envelope to stdout as a single JSON document. |
| `--out <file>` | Write that same JSON document to `<file>` as UTF-8 without a byte-order mark. |
| `--yes` | Confirm every destructive step. This is an accident guard, not authorization. |
| `--dry-run` | Validate and resolve the action without calling its handler. |
| `--file <job.json>` | Job path. Valid only with `job run`. |

`--<arg> <value>` and `--<arg>=<value>` set one scalar argument. Unknown arguments, repeated arguments, missing values, and non-scalar values are `E_ARGS`. Flag names are case-sensitive.

The engine parameter is `-Confirmed`. Do not declare `-Confirm`. `-Confirm` collides with PowerShell's common confirmation parameter, and this framework does not enable `SupportsShouldProcess`.

`--yes` maps to `-Confirmed`. There is no interactive prompt unless the caller sets `-AllowPrompt` and stdin, stdout, and the process are all interactive. The default answer is no. A non-interactive call without `--yes` returns `E_CONFIRM` and does not run the handler.

## Exit codes

| Exit | Code | When |
| --- | --- | --- |
| 0 |  | Success. |
| 2 | `E_ARGS` | Bad grammar, bad types, unknown arguments, schema failure. |
| 3 | `E_NOT_FOUND` | Action or route is not registered. |
| 4 | `E_CONFIRM` | Destructive action was not confirmed. |
| 5 | `E_AUTH` | Host, Origin, or bearer token failed. CLI calls do not use this code. |
| 1 | `E_INTERNAL` | Unexpected failure. The message is exactly `An internal error occurred.` |

## Output and encoding

`--json` writes one envelope to stdout and nothing else. The envelope shape is defined in `result.schema.json`.

`--out` writes the same bytes a UTF-8 encoder emits when the byte-order mark is disabled. The file does not start with `EF BB BF`. Stdout encoding is independent of that file.

Human text, when `--json` is absent, is also written to stdout. The process exit code still carries the status.

## Stable identifiers

Action ids are `app.noun.verb` using the lowercase app, noun, and verb. The id is stable for the life of that action. Discovery lists `id`, `app`, `noun`, `verb`, `description`, `destructive`, and `parameters`.

Entity ids are the `id` string an action returns when it identifies a domain object. An entity id matches `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`. Callers treat it as immutable. The framework does not mint a replacement. Step ids inside jobs are separate and match `^[A-Za-z][A-Za-z0-9_-]{0,63}$`.

## Dry-run

`--dry-run` checks that the action exists and that arguments are known scalars of the declared types. It does not call the handler and does not require `--yes`. The result is:

```json
{
  "dryRun": true,
  "actionId": "app.noun.verb",
  "app": "app",
  "noun": "noun",
  "verb": "verb",
  "args": {},
  "destructive": false,
  "confirmationRequired": false
}
```

`confirmationRequired` is true when the action is destructive and `-Confirmed` was not passed.

## Windows PowerShell 5.1 entry

The app entry is a `.ps1` file whose first requirement is `#requires -Version 5.1`. Launch it with:

```text
%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -File <app>.ps1 <noun> <verb> --json
```

The script uses Windows PowerShell 5.1 syntax only. `ConvertFrom-Json` returns a `PSCustomObject`. Read properties with `PSObject.Properties`. Do not call `ContainsKey` on JSON objects. Every `ConvertTo-Json` call passes `-Depth`. Do not use `ConvertFrom-Json -AsHashtable`, the null-coalescing operators, or `ForEach-Object -Parallel`.

## JSON-only jobs

`job run --file` accepts a version 1 job document. See `JOB-FORMAT.md`.
