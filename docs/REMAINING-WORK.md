# Remaining work

The open work is tracked as issues, each with what it needs and how to tell it is done. This page is only the map from roadmap rows to issues, so the two cannot drift apart. [ROADMAP.md](ROADMAP.md) has the row-by-row status; a row is ticked only when code and a passing test back it.

Roadmap score today: **57.5 of 67 rows (85.8%)**. Group A takes it to 61.5 (91.8%); Group B takes it to 67.

## Group A: host-side capture and hotkeys (+4.0 rows, reaches 90%)

| Issue | Roadmap rows | Rows |
| --- | --- | --- |
| [#21](https://github.com/fleethacker-data-crucible/Capstan/issues/21) Global hotkeys, tray icon, keeping Capstan out of the capture | Global hotkeys, tray, studio not in the shot | +1.0 |
| [#22](https://github.com/fleethacker-data-crucible/Capstan/issues/22) Capture cursor and key events to a `.cursor.json` sidecar | Cursor data | +0.5 |
| [#23](https://github.com/fleethacker-data-crucible/Capstan/issues/23) Verify the cursor-effect rows against real captured data | Cursor smoothing, highlight and magnify, click effects, smart focus, keystroke callouts | +2.5 |

## Group B: the last 5.5 rows

| Issue | Roadmap row | Rows |
| --- | --- | --- |
| [#24](https://github.com/fleethacker-data-crucible/Capstan/issues/24) Speech-to-text through Windows speech recognition | Speech-to-text | +1.0 |
| [#25](https://github.com/fleethacker-data-crucible/Capstan/issues/25) Chunked, token-checked file transfer and the library on disk | Library on disk | +0.5 |
| [#26](https://github.com/fleethacker-data-crucible/Capstan/issues/26) Import SnapShackle captures through the host | Import SnapShackle captures | +0.5 |
| [#27](https://github.com/fleethacker-data-crucible/Capstan/issues/27) Decide what the `.capstan` file carries: decided, `.capstan` stays edit-only and `.capstanz` is the portable form (done) | Project file | +0.5 |
| [#28](https://github.com/fleethacker-data-crucible/Capstan/issues/28) Fast export beyond H.264 MP4 and VP8/VP9 WebM | Fast export | +0.5 |
| [#29](https://github.com/fleethacker-data-crucible/Capstan/issues/29) Full WebGL2 compositor | WebGL2 compositor | +0.5 |
| [#30](https://github.com/fleethacker-data-crucible/Capstan/issues/30) Webcam background removal | Background removal | +1.0 |
| [#31](https://github.com/fleethacker-data-crucible/Capstan/issues/31) Interactive player: decide where it lives (decided: Scrimshaw, see ROADMAP.md) | Interactive player | +1.0 |

## Command-line and API parity (not a roadmap row)

The Fleet CLI parity proposal in the comms repo. Capstan's engine runs in the browser and the Windows PC has no Node or Bun, so the design is a command bridge through the PowerShell host.

| Issue | What |
| --- | --- |
| [#32](https://github.com/fleethacker-data-crucible/Capstan/issues/32) | Command registry for every GUI action |
| [#33](https://github.com/fleethacker-data-crucible/Capstan/issues/33) | Host bridge, session token and `Capstan-CLI.bat` |
| [#34](https://github.com/fleethacker-data-crucible/Capstan/issues/34) | Parity test in CI, `docs/CLI.md` and a published project schema |

## Verification

[#35](https://github.com/fleethacker-data-crucible/Capstan/issues/35): the hand-test checklist for the open pull requests (real microphone, webcam and desktop capture, GPU effects, native pickers, crash recovery).

## Suggested order

1. Merge the open pull requests after CI and #35.
2. #32 and #33 (command registry and bridge), because the demo pipeline wants to drive Capstan from scripts; #25 shares its file-transfer work.
3. Group A (#21 to #23).
4. #24, then #25 and #26 together.
5. Leave #28 to #31 until after the event. The team code freeze is Nov 4, 2026 at 12:00 ET; after that, changes to existing repos need the Chief of Staff's approval.
