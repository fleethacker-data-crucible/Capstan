# FleetAction versioning

Version 1.0.0 of this repository is the canonical module. Apps do not track `main`. They pin a release.

## What is released

The tag `v1.0.0` matches `ModuleVersion` in `FleetAction.psd1`. The release attaches:

| Asset | Role |
| --- | --- |
| `FleetAction.zip` | Module, contracts, conformance test, and the Pester install script. |
| `FleetAction.zip.sha256` | SHA256 of the zip, uppercase hex, two spaces, then the file name. |

The line looks like this:

```text
<64 hex chars>  FleetAction.zip
```

## How an app vendors it

1. Choose a tag (`v1.0.0`) or the commit SHA that tag points at. Record it in the app repo, for example `fleet-action.lock.json`:

   ```json
   {
     "version": "1.0.0",
     "tag": "v1.0.0",
     "sha256": "<64 hex chars from the release>"
   }
   ```

2. Download `FleetAction.zip` and `FleetAction.zip.sha256` from that GitHub release.
3. Compute SHA256 with `Get-FileHash -Algorithm SHA256`. Compare it to the `.sha256` asset and to the hash pinned in the app repo. Both must match. A mismatch is a failed build.
4. Expand the zip. Import `FleetAction.psd1` from that copy. Do not import an unpinned checkout of this repository.
5. Call the reusable workflow `.github/workflows/fleet-action-conformance.yml` at the same tag or at the full commit SHA of that tag. Pass `fleet-action-version` and the pinned `sha256`. See `docs/ORG-WORKFLOW.md`.

## What the zip contains

```text
FleetAction.psd1
FleetAction.psm1
LICENSE
contracts/
tests/Conformance.Tests.ps1
tools/Install-PinnedPester.ps1
tools/Invoke-FleetTests.ps1
```

Contracts inside the zip are the contract for that version. An app does not mix a newer contract with an older module.

## Moving versions

Bump the app's lock file and the workflow `uses:` ref in the same change. Read the contract diff before adopting a new minor version. A new major version may break the envelope, the routes, or the job schema.

CI in this repository installs Pester 5.9.1 from the PowerShell Gallery nupkg and checks its SHA256 before import. The pinned digest is in `tools/Install-PinnedPester.ps1`.
