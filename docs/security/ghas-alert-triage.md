# GHAS alert triage (sprint 2026-11)

Open code-scanning alerts on this repo, and what this sprint did with each one. Alerts were not dismissed from here. For an accepted alert, the dismissal reason is the one to use on GitHub (`false positive`, `won't fix`, or `used in tests`).

| Alert | Rule | Path | Disposition | Reason |
|---|---|---|---|---|
| code-scanning 1 | actions/missing-workflow-permissions | `.github/workflows/tests.yml` (build-and-test) | fixed | Workflow `permissions: contents: read`. Checkout only reads the repo; artifact upload uses the Actions runtime token. `runs-on` is unchanged. |
| code-scanning 2 | actions/missing-workflow-permissions | `.github/workflows/tests.yml` (windows-host) | fixed | Same workflow-level `contents: read` block covers this job. It only checks out the repo and runs the PowerShell tests. |
| code-scanning 3 | js/incomplete-sanitization | `scripts/gen-cli-doc.ts` | fixed | Table cells escape `\` before `\|`, so a backslash cannot leave a pipe unescaped. Current command text has neither, so `docs/CLI.md` does not change. |
| code-scanning 4 | js/incomplete-sanitization | `tests/e2e/captions-markers.e2e.mjs` | fixed | The merge check replaced only the first newline. It now replaces every newline; the cue under test still has one. |
| code-scanning 5 | js/bad-tag-filter | `src/engine/markers.ts` | fixed | Chapter WebVTT escaped `-->` and not `--!>`. Titles now escape `&`, `<` and `>`, so neither comment end can appear. A re-import still decodes the title. |
| code-scanning 6 | js/incomplete-multi-character-sanitization | `src/engine/captions.ts` | fixed | Styling tags are removed by a scan that repeats, not one `replace` of `<...>`. Real cues (`<i>`, `<v>`) are unchanged. `a < b`, `<3` and URLs stay. An unclosed `script`, `iframe` or `style` tag is dropped. |
| code-scanning 7 | js/incomplete-multi-character-sanitization | `tools/gen-icons.mjs` | fixed | SVG comments are parsed, closed by `-->` or `--!>`, and removed again if a cut reassembles `<!--`. An unclosed comment is dropped to end of file. Ordinary Lucide comments still disappear and the icon body is the same. |
| code-scanning 8 | js/xss-through-dom | `src/engine/media.ts` | accept: false positive | Dismissal: **false positive**. `el.src` is set only on a `<video>` or `<audio>` element, and only to the `blob:` URL from `URL.createObjectURL`. That URL cannot be a `javascript:` URL, and those elements do not parse the blob as HTML. |

Nothing in this list is waiting on an owner decision. Alert 8 is the one to dismiss on GitHub; the others should close when code scanning next runs on this branch.
