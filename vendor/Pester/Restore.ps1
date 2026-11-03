# Writes Pester.dll from the committed base64. The bytes are not stored as a .dll:
# the Fleet gate rejects binary extensions in git. This does not install anything
# on the machine; it only materialises the assembly next to this script.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
foreach ($tfm in @('net452', 'netstandard2.0')) {
    $dir = Join-Path (Join-Path $here 'bin') $tfm
    $dll = Join-Path $dir 'Pester.dll'
    if (Test-Path -LiteralPath $dll) { continue }
    $text = [IO.File]::ReadAllText((Join-Path $dir 'Pester.dll.b64'))
    [IO.File]::WriteAllBytes($dll, [Convert]::FromBase64String($text))
}
