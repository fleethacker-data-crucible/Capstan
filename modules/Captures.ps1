<#
  Read-only access to the SnapShackle captures folder (roadmap row "Import SnapShackle captures").
  Windows PowerShell 5.1, no Add-Type, no writes, no network. ASCII only.

  Exposed by Start-Capstan.ps1 as:
    GET /api/snapshackle/captures          the newest 500 captures with their OCR text
    GET /api/snapshackle/captures/<name>   one capture file, streamed in 1 MB buffers
  and as "snapshackle": true on /api/health when a captures folder exists.

  The only folders ever read are the first that exists of
    %LOCALAPPDATA%\SnapShackle\Captures, %LOCALAPPDATA%\CutterMk\Captures, %LOCALAPPDATA%\Lasso\Captures
  (or, only when CAPSTAN_TEST_CAPTURES is set, that one folder: a test-only seam; the same rules apply).
  A request never supplies a path. It supplies one name, which must match a strict pattern and an
  extension allowlist, and the resolved full path must be a plain file directly inside the folder.
#>

$script:CapstanCaptureLimit = 500
$script:CapstanCaptureOcrMaxBytes = 20480
$script:CapstanCaptureSidecarMaxBytes = 524288
$script:CapstanCaptureNamePattern = '\A[A-Za-z0-9 _.()+-]{1,120}\z'
$script:CapstanCaptureTypes = @{
    '.png'  = @{ Mime = 'image/png';  Kind = 'image' }
    '.jpg'  = @{ Mime = 'image/jpeg'; Kind = 'image' }
    '.jpeg' = @{ Mime = 'image/jpeg'; Kind = 'image' }
    '.webp' = @{ Mime = 'image/webp'; Kind = 'image' }
    '.gif'  = @{ Mime = 'image/gif';  Kind = 'image' }
    '.mp4'  = @{ Mime = 'video/mp4';  Kind = 'video' }
    '.webm' = @{ Mime = 'video/webm'; Kind = 'video' }
}
$script:CapstanReservedDeviceNames = @('CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$', 'CLOCK$') + @(0..9 | ForEach-Object { 'COM' + $_; 'LPT' + $_ })

# ---- Which folder ----

function Get-CapstanCapturesCandidates {
    # The test seam is honoured only when the variable is set; then it is the only candidate.
    $override = $env:CAPSTAN_TEST_CAPTURES
    if (-not [string]::IsNullOrEmpty($override)) { return @($override) }
    $local = $env:LOCALAPPDATA
    if ([string]::IsNullOrEmpty($local)) { return @() }
    return @(
        [IO.Path]::Combine($local, 'SnapShackle', 'Captures'),
        [IO.Path]::Combine($local, 'CutterMk', 'Captures'),
        [IO.Path]::Combine($local, 'Lasso', 'Captures')
    )
}

function Test-CapstanReparsePoint($Info) {
    return (($Info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}

# Returns the canonical captures folder (no trailing separator) or $null when there is none.
function Get-CapstanCapturesRoot {
    foreach ($candidate in @(Get-CapstanCapturesCandidates)) {
        try {
            if ([string]::IsNullOrWhiteSpace($candidate) -or $candidate.IndexOf([char]0) -ge 0) { continue }
            # Absolute, local, drive-letter paths only: no relative path, UNC share or device path.
            if (-not [IO.Path]::IsPathRooted($candidate) -or $candidate.StartsWith('\\') -or $candidate.StartsWith('//')) { continue }
            $full = [IO.Path]::GetFullPath($candidate)
            $root = $full.TrimEnd('\', '/')
            if ($root.Length -lt 3 -or $root -notmatch '\A[A-Za-z]:\\') { continue }
            $dir = New-Object IO.DirectoryInfo -ArgumentList $root
            if (-not $dir.Exists) { continue }
            if (Test-CapstanReparsePoint $dir) { continue }
            return $dir.FullName.TrimEnd('\', '/')
        } catch { continue }
    }
    return $null
}

# ---- Names ----

# One path segment from a strict alphabet, an allowed extension, and nothing Windows treats specially.
function Test-CapstanCaptureName($Name) {
    if ($Name -isnot [string]) { return $false }
    if ($Name -cnotmatch $script:CapstanCaptureNamePattern) { return $false }
    if ($Name.Contains('..')) { return $false }
    if ($Name.EndsWith('.') -or $Name.EndsWith(' ') -or $Name.StartsWith(' ')) { return $false }
    $ext = [IO.Path]::GetExtension($Name).ToLowerInvariant()
    if (-not $script:CapstanCaptureTypes.ContainsKey($ext)) { return $false }
    $stem = $Name.Substring(0, $Name.Length - $ext.Length)
    if ($stem.Trim().Length -eq 0) { return $false }
    # Windows reads CON.png, con.anything and "CON .png" as the console device.
    $device = $Name.Split('.')[0].TrimEnd(' ').ToUpperInvariant()
    if ($script:CapstanReservedDeviceNames -contains $device) { return $false }
    return $true
}

function Get-CapstanCaptureInfo([string]$Name) {
    return $script:CapstanCaptureTypes[[IO.Path]::GetExtension($Name).ToLowerInvariant()]
}

# Full path of a plain file named $Name directly inside $Root, or $null. Never throws.
function Resolve-CapstanCapturePath([string]$Root, [string]$Name, [string]$Suffix = '') {
    try {
        if ([string]::IsNullOrEmpty($Root) -or -not (Test-CapstanCaptureName $Name)) { return $null }
        $leaf = $Name + $Suffix
        if ($Suffix -and $Suffix -ne '.meta.json') { return $null }
        $full = [IO.Path]::GetFullPath([IO.Path]::Combine($Root, $leaf))
        if (-not [string]::Equals([IO.Path]::GetDirectoryName($full), $Root, [StringComparison]::OrdinalIgnoreCase)) { return $null }
        if (-not [string]::Equals([IO.Path]::GetFileName($full), $leaf, [StringComparison]::Ordinal)) { return $null }
        $info = New-Object IO.FileInfo -ArgumentList $full
        if (-not $info.Exists) { return $null }
        if (Test-CapstanReparsePoint $info) { return $null }
        return $info.FullName
    } catch { return $null }
}

# ---- OCR sidecar ----

function Limit-CapstanOcrText([string]$Text) {
    $max = $script:CapstanCaptureOcrMaxBytes
    $t = $Text
    if ($t.Length -gt $max) { $t = $t.Substring(0, $max) }
    $utf8 = New-Object Text.UTF8Encoding -ArgumentList $false
    while ($t.Length -gt 0) {
        $bytes = $utf8.GetByteCount($t)
        if ($bytes -le $max) { break }
        $t = $t.Substring(0, [Math]::Max(0, $t.Length - [Math]::Max(1, [int][Math]::Floor(($bytes - $max) / 4))))
    }
    if ($t.Length -gt 0 -and [char]::IsHighSurrogate($t[$t.Length - 1])) { $t = $t.Substring(0, $t.Length - 1) }
    return $t
}

# The text SnapShackle stored in NAME.png.meta.json ("ocr"), capped at 20 KB, or '' when there is none.
function Read-CapstanCaptureOcr([string]$Root, [string]$Name) {
    $path = Resolve-CapstanCapturePath $Root $Name '.meta.json'
    if (-not $path) { return '' }
    try {
        $fs = New-Object IO.FileStream -ArgumentList $path, ([IO.FileMode]::Open), ([IO.FileAccess]::Read), ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
        try {
            if ($fs.Length -gt $script:CapstanCaptureSidecarMaxBytes) { return '' }
            $buffer = New-Object byte[] ([int]$fs.Length)
            $got = 0
            while ($got -lt $buffer.Length) {
                $n = $fs.Read($buffer, $got, $buffer.Length - $got)
                if ($n -le 0) { break }
                $got += $n
            }
        } finally { $fs.Dispose() }
        $text = (New-Object Text.UTF8Encoding -ArgumentList $false).GetString($buffer, 0, $got).TrimStart([char]0xFEFF)
        $meta = $text | ConvertFrom-Json
        if ($null -eq $meta -or -not $meta.PSObject.Properties['ocr']) { return '' }
        $ocr = $meta.ocr
        if ($ocr -isnot [string]) { return '' }
        return (Limit-CapstanOcrText $ocr)
    } catch { return '' }
}

# ---- Listing ----

# Newest first, at most 500: name, size, modified (UTC, ISO 8601), kind, hasOcr, ocr. Subfolders and
# everything outside the allowlist are ignored. Total is how many matching files the folder holds.
function Get-CapstanCaptureList([string]$Root) {
    $files = @()
    try { $files = @((New-Object IO.DirectoryInfo -ArgumentList $Root).GetFiles()) } catch { $files = @() }
    $usable = @($files | Where-Object { (Test-CapstanCaptureName $_.Name) -and -not (Test-CapstanReparsePoint $_) })
    $newest = @($usable | Sort-Object -Property @{ Expression = { $_.LastWriteTimeUtc }; Descending = $true }, @{ Expression = { $_.Name }; Descending = $false } | Select-Object -First $script:CapstanCaptureLimit)
    $items = @()
    foreach ($file in $newest) {
        $ocr = Read-CapstanCaptureOcr $Root $file.Name
        $items += [ordered]@{
            name     = $file.Name
            size     = [long]$file.Length
            modified = $file.LastWriteTimeUtc.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
            kind     = (Get-CapstanCaptureInfo $file.Name).Kind
            hasOcr   = ($ocr.Trim().Length -gt 0)
            ocr      = $ocr
        }
    }
    return [ordered]@{ captures = $items; total = $usable.Count; limit = $script:CapstanCaptureLimit }
}

# ---- Routing ----

# Reads the route from the path exactly as the client sent it (the parsed Uri has already merged "..").
# kind: list | file | none. A file route carries the percent-decoded name and whether it is acceptable.
function Split-CapstanCaptureRoute([string]$RawPath) {
    $p = $RawPath
    $q = $p.IndexOfAny([char[]]@('?', '#'))
    if ($q -ge 0) { $p = $p.Substring(0, $q) }
    $base = '/api/snapshackle/captures'
    if ($p -ceq $base -or $p -ceq ($base + '/')) { return @{ kind = 'list'; name = ''; valid = $true } }
    if (-not $p.StartsWith($base + '/', [StringComparison]::Ordinal)) { return @{ kind = 'none'; name = ''; valid = $false } }
    $rest = $p.Substring($base.Length + 1)
    $name = $null
    try { $name = [Uri]::UnescapeDataString($rest) } catch { $name = $null }
    # Decoded once only: a second layer (%255c) leaves a percent sign, which the name pattern refuses.
    return @{ kind = 'file'; name = [string]$name; valid = ($null -ne $name -and (Test-CapstanCaptureName $name)) }
}

# Handles both routes. Send-Json and Send-CapstanFile come from Start-Capstan.ps1.
function Invoke-CapstanCaptureRoute($Context, [string]$Method, [string]$RawPath) {
    $route = Split-CapstanCaptureRoute $RawPath
    if ($route.kind -eq 'none') { Send-Json $Context @{ error = 'Route not found' } 404; return }
    if ($Method -ne 'GET') {
        $Context.Response.Headers.Add('Allow', 'GET')
        Send-Json $Context @{ error = 'Method not allowed' } 405
        return
    }
    $root = Get-CapstanCapturesRoot
    if (-not $root) { Send-Json $Context @{ error = 'No SnapShackle captures folder found' } 404; return }
    if ($route.kind -eq 'list') { Send-Json $Context (Get-CapstanCaptureList $root) 200; return }
    if (-not $route.valid) { Send-Json $Context @{ error = 'Invalid capture name' } 400; return }
    $path = Resolve-CapstanCapturePath $root $route.name
    if (-not $path) { Send-Json $Context @{ error = 'Capture not found' } 404; return }
    $stream = $null
    try {
        $stream = New-Object IO.FileStream -ArgumentList $path, ([IO.FileMode]::Open), ([IO.FileAccess]::Read), ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete), 65536
    } catch {
        Send-Json $Context @{ error = 'Capture could not be read' } 404
        return
    }
    # Send-CapstanFile owns the stream from here and closes it.
    Send-CapstanFile $Context $stream $stream.Length (Get-CapstanCaptureInfo $route.name).Mime
}
