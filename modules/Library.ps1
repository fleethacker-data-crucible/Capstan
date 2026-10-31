<#
  Capstan media library on disk. Dot-sourced by Start-Capstan.ps1 (and by tests/ps/Library.Tests.ps1).

  Why: the browser keeps a project's media per address, and the port is part of the address, so a project
  opened on another port (or after the browser profile was cleared) lost its media. The host keeps a copy
  of each media file under %LOCALAPPDATA%\Capstan\library\<id>, behind token-checked routes:

    GET    /api/files                  index: id, size, modified
    POST   /api/files                  start (or resume) an upload: {id, size, sha256?, chunkSize?}
    PUT    /api/files/<id>?part=N      one raw chunk (at most 8 MB) of a started upload
    POST   /api/files/<id>/complete    check size and SHA-256, move the file into the library
    GET    /api/files/<id>             stream the file in 1 MB buffers; one Range: bytes=a-b is supported
    DELETE /api/files/<id>             abort an upload and/or remove the stored file (?upload=1: upload only)

  Rules (docs/ARCHITECTURE.md, "Security notes: library"):
    - One root folder; the file name comes from an id matching [a-z0-9_-]{1,80} and never from a path in a
      request. The resolved path must be a direct child of the root (no drive, UNC, ':' stream, reserved
      device name, trailing dot or space, reparse point).
    - Nothing is read or written in more than 1 MB at a time; chunks are written into a temp file under
      <root>\.uploads at part*chunkSize, so an upload is resumable per part and never held in memory.
    - Limits: max stored file size, free disk space (plus a reserve), parallel uploads, idle timeout.
      Temp uploads left by an earlier run are removed at start; idle ones after the timeout.
    - Errors are {"error": "...", "code": "..."} and never contain a path or an exception message.
  Windows PowerShell 5.1, ASCII only.
#>

$script:CapstanLibrary = $null
$script:CapstanLibraryReserved = @('con', 'prn', 'aux', 'nul', 'conin', 'conout', 'clock') + @(0..9 | ForEach-Object { 'com' + $_; 'lpt' + $_ })

function Get-CapstanLibraryEnvNumber {
    param([string]$Name, [long]$Default, [long]$Min, [long]$Max)
    $raw = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($raw)) { return $Default }
    $n = 0L
    if (-not [long]::TryParse($raw.Trim(), [Globalization.NumberStyles]::None, [Globalization.CultureInfo]::InvariantCulture, [ref]$n)) { return $Default }
    if ($n -lt $Min -or $n -gt $Max) { return $Default }
    return $n
}

function Test-CapstanReparsePoint {
    param([string]$Path)
    try {
        $attr = [IO.File]::GetAttributes($Path)
        return (($attr -band [IO.FileAttributes]::ReparsePoint) -ne 0)
    } catch { return $false }
}

function Initialize-CapstanLibrary {
    <#
      Creates the library folder and the state the routes use. Returns $true when the library is on.
      Settings come from parameters, else from environment variables (all optional):
        CAPSTAN_LIBRARY=0                    turn the library off (the page keeps media in the browser only)
        CAPSTAN_LIBRARY_ROOT                 another LOCAL folder (default %LOCALAPPDATA%\Capstan\library)
        CAPSTAN_LIBRARY_MAX_BYTES            largest stored file (default 16 GiB)
        CAPSTAN_LIBRARY_MAX_UPLOADS          uploads in flight (default 4)
        CAPSTAN_LIBRARY_STALE_SECONDS        idle upload is removed after this (default 1800)
        CAPSTAN_LIBRARY_RESERVE_BYTES        free space that must remain after an upload (default 256 MiB)
    #>
    param(
        [string]$Root,
        [long]$MaxFileBytes = 0,
        [int]$MaxUploads = 0,
        [int]$StaleSeconds = 0,
        [long]$ReserveBytes = -1
    )
    $script:CapstanLibrary = $null
    if ($env:CAPSTAN_LIBRARY -and $env:CAPSTAN_LIBRARY.Trim() -match '^(0|false|no|off)$') { return $false }
    if (-not $Root) { $Root = $env:CAPSTAN_LIBRARY_ROOT }
    if (-not $Root) {
        if (-not $env:LOCALAPPDATA) { Write-Warning 'The on-disk media library is off: LOCALAPPDATA is not set.'; return $false }
        $Root = Join-Path $env:LOCALAPPDATA 'Capstan\library'
    }
    if ($MaxFileBytes -le 0) { $MaxFileBytes = Get-CapstanLibraryEnvNumber 'CAPSTAN_LIBRARY_MAX_BYTES' (16GB) 1 (1TB) }
    if ($MaxUploads -le 0) { $MaxUploads = [int](Get-CapstanLibraryEnvNumber 'CAPSTAN_LIBRARY_MAX_UPLOADS' 4 1 32) }
    if ($StaleSeconds -le 0) { $StaleSeconds = [int](Get-CapstanLibraryEnvNumber 'CAPSTAN_LIBRARY_STALE_SECONDS' 1800 1 86400) }
    if ($ReserveBytes -lt 0) { $ReserveBytes = Get-CapstanLibraryEnvNumber 'CAPSTAN_LIBRARY_RESERVE_BYTES' (256MB) 0 (1TB) }
    try {
        # Local drive letters only: no UNC share, no device path, no relative path.
        if ($Root -notmatch '^[A-Za-z]:\\') { throw 'not a local drive path' }
        $full = [IO.Path]::GetFullPath($Root).TrimEnd('\')
        if ($full.Length -lt 4) { throw 'not a folder' }
        if (-not [IO.Directory]::Exists($full)) { [void][IO.Directory]::CreateDirectory($full) }
        $uploads = Join-Path $full '.uploads'
        if (-not [IO.Directory]::Exists($uploads)) { [void][IO.Directory]::CreateDirectory($uploads) }
        if ((Test-CapstanReparsePoint $full) -or (Test-CapstanReparsePoint $uploads)) { throw 'link' }
        # Uploads that were still open when an earlier run ended are of no use any more.
        foreach ($f in [IO.Directory]::GetFiles($uploads)) { try { [IO.File]::Delete($f) } catch { } }
    } catch {
        Write-Warning 'The on-disk media library is off: its folder could not be prepared (check CAPSTAN_LIBRARY_ROOT and permissions).'
        return $false
    }
    $script:CapstanLibrary = @{
        Root         = $full
        Uploads      = $uploads
        Prefix       = $full + '\'
        Active       = @{}
        MaxFileBytes = $MaxFileBytes
        MaxUploads   = $MaxUploads
        StaleSeconds = $StaleSeconds
        Reserve      = $ReserveBytes
        ChunkMax     = 8388608
        ChunkMin     = 65536
        LastSweep    = [DateTime]::UtcNow
    }
    return $true
}

function Test-CapstanLibraryEnabled { return ($null -ne $script:CapstanLibrary) }

function Get-CapstanLibraryInfo {
    # What /api/health tells the page. Never the folder.
    if ($null -eq $script:CapstanLibrary) { return @{ library = $false } }
    return @{ library = $true; libraryMaxBytes = $script:CapstanLibrary.MaxFileBytes; libraryChunkBytes = $script:CapstanLibrary.ChunkMax }
}

function Test-CapstanLibraryId {
    param([string]$Id)
    if ([string]::IsNullOrEmpty($Id)) { return $false }
    # \z, not $: "$" also matches before a trailing newline.
    if ($Id -cnotmatch '^[a-z0-9_-]{1,80}\z') { return $false }
    if ($script:CapstanLibraryReserved -contains $Id) { return $false }
    return $true
}

function Resolve-CapstanLibraryFile {
    <# Full path of the stored file for an id, or $null when the id is not acceptable or the path would leave the root. #>
    param([string]$Id)
    $lib = $script:CapstanLibrary
    if ($null -eq $lib -or -not (Test-CapstanLibraryId $Id)) { return $null }
    try { $full = [IO.Path]::GetFullPath([IO.Path]::Combine($lib.Root, $Id)) } catch { return $null }
    if (-not $full.StartsWith($lib.Prefix, [StringComparison]::OrdinalIgnoreCase)) { return $null }
    if (-not ([IO.Path]::GetDirectoryName($full)).Equals($lib.Root, [StringComparison]::OrdinalIgnoreCase)) { return $null }
    if ($full.Substring($lib.Prefix.Length) -ne $Id) { return $null }
    if (Test-CapstanReparsePoint $full) { return $null }
    return $full
}

function Resolve-CapstanLibraryTemp {
    param([string]$Id)
    $lib = $script:CapstanLibrary
    if ($null -eq $lib -or -not (Test-CapstanLibraryId $Id)) { return $null }
    $full = [IO.Path]::GetFullPath([IO.Path]::Combine($lib.Uploads, $Id + '.part'))
    if (-not $full.StartsWith($lib.Uploads + '\', [StringComparison]::OrdinalIgnoreCase)) { return $null }
    if (Test-CapstanReparsePoint $full) { return $null }
    return $full
}

function Test-CapstanLibraryRoom {
    <# True when `Size` more bytes fit on the library's drive with the reserve to spare, counting uploads already under way. #>
    param([long]$Size, [string]$ExceptId)
    $lib = $script:CapstanLibrary
    try {
        $free = ([IO.DriveInfo]::new($lib.Root.Substring(0, 1))).AvailableFreeSpace
    } catch { return $false }
    $pending = 0L
    foreach ($u in @($lib.Active.Values)) { if ($u.Id -ne $ExceptId) { $pending += $u.Size } }
    return (($free - $pending - $lib.Reserve) -ge $Size)
}

function Test-CapstanTokenEqual {
    # Compares without stopping at the first difference.
    param([string]$Given, [string]$Expected)
    if ([string]::IsNullOrEmpty($Given) -or [string]::IsNullOrEmpty($Expected)) { return $false }
    $a = [Text.Encoding]::UTF8.GetBytes($Given)
    $b = [Text.Encoding]::UTF8.GetBytes($Expected)
    $diff = $a.Length -bxor $b.Length
    $n = [Math]::Min($a.Length, $b.Length)
    for ($i = 0; $i -lt $n; $i++) { $diff = $diff -bor ($a[$i] -bxor $b[$i]) }
    return ($diff -eq 0)
}

function Remove-CapstanLibraryUpload {
    param([string]$Id)
    $lib = $script:CapstanLibrary
    if ($null -eq $lib) { return }
    $u = $lib.Active[$Id]
    if ($null -ne $u) {
        if ($null -ne $u.Hasher) { try { $u.Hasher.Dispose() } catch { } }
        $lib.Active.Remove($Id)
        try { if ($u.Temp) { [IO.File]::Delete($u.Temp) } } catch { }
    }
}

function Invoke-CapstanLibrarySweep {
    <# Removes uploads that have been idle for the stale timeout, and strays in .uploads. Cheap; called often. #>
    param([switch]$Force)
    $lib = $script:CapstanLibrary
    if ($null -eq $lib) { return }
    $now = [DateTime]::UtcNow
    $interval = [Math]::Min(15.0, $lib.StaleSeconds / 2.0)
    if (-not $Force -and ($now - $lib.LastSweep).TotalSeconds -lt $interval) { return }
    $lib.LastSweep = $now
    foreach ($id in @($lib.Active.Keys)) {
        if (($now - $lib.Active[$id].Last).TotalSeconds -ge $lib.StaleSeconds) { Remove-CapstanLibraryUpload $id }
    }
    try {
        $known = @{}
        foreach ($u in @($lib.Active.Values)) { $known[$u.Temp] = $true }
        foreach ($f in [IO.Directory]::GetFiles($lib.Uploads)) {
            if (-not $known.ContainsKey($f) -and ($now - [IO.File]::GetLastWriteTimeUtc($f)).TotalSeconds -ge $lib.StaleSeconds) { [IO.File]::Delete($f) }
        }
    } catch { }
}

function Clear-CapstanLibraryUploads {
    # On shutdown: nothing half-written is left behind.
    $lib = $script:CapstanLibrary
    if ($null -eq $lib) { return }
    foreach ($id in @($lib.Active.Keys)) { Remove-CapstanLibraryUpload $id }
}

function Enter-CapstanLibraryJob { if ($null -ne $script:presence) { $script:presence.BeginJob() } }
function Exit-CapstanLibraryJob { if ($null -ne $script:presence) { $script:presence.EndJob() } }

function Send-CapstanLibraryError {
    param($Context, [int]$Status, [string]$Code, [string]$Message)
    Send-Json $Context @{ error = $Message; code = $Code } $Status
}

function Read-CapstanLibraryJson {
    <# Reads a small JSON body. Returns @{ ok = $true; value = <object or $null> } or @{ ok = $false; status; code; message }. #>
    param($Request, [int]$Max = 4096)
    if ($Request.ContentLength64 -gt $Max) { return @{ ok = $false; status = 413; code = 'body_too_large'; message = 'Request body too large' } }
    if ($Request.ContentLength64 -le 0) { return @{ ok = $true; value = $null } }
    $ct = ([string]$Request.Headers['Content-Type']).Split(';')[0].Trim().ToLowerInvariant()
    if ($ct -ne 'application/json') { return @{ ok = $false; status = 415; code = 'content_type'; message = 'Content-Type must be application/json' } }
    $buffer = New-Object byte[] ([int]$Request.ContentLength64)
    $n = 0
    while ($n -lt $buffer.Length) {
        $got = $Request.InputStream.Read($buffer, $n, $buffer.Length - $n)
        if ($got -le 0) { break }
        $n += $got
    }
    try { $value = [Text.Encoding]::UTF8.GetString($buffer, 0, $n) | ConvertFrom-Json } catch { $value = $null }
    if ($null -eq $value -or $value -isnot [System.Management.Automation.PSCustomObject]) {
        return @{ ok = $false; status = 400; code = 'bad_json'; message = 'The body must be a JSON object' }
    }
    return @{ ok = $true; value = $value }
}

function Get-CapstanLibraryProp {
    param($Object, [string]$Name)
    if ($null -eq $Object -or -not $Object.PSObject.Properties[$Name]) { return $null }
    return $Object.PSObject.Properties[$Name].Value
}

function Test-CapstanWholeNumber {
    param($Value)
    return (($Value -is [int]) -or ($Value -is [long]))
}

function Get-CapstanFileSha256 {
    param([string]$Path)
    $sha = New-Object System.Security.Cryptography.SHA256CryptoServiceProvider
    $fs = [IO.FileStream]::new($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read, 1048576, [IO.FileOptions]::SequentialScan)
    try {
        $buffer = New-Object byte[] 1048576
        while (($got = $fs.Read($buffer, 0, $buffer.Length)) -gt 0) { [void]$sha.TransformBlock($buffer, 0, $got, $null, 0) }
        [void]$sha.TransformFinalBlock($buffer, 0, 0)
        return (ConvertTo-CapstanHex $sha.Hash)
    } finally { $fs.Dispose(); $sha.Dispose() }
}

function ConvertTo-CapstanHex {
    param([byte[]]$Bytes)
    $sb = New-Object Text.StringBuilder
    foreach ($b in $Bytes) { [void]$sb.Append($b.ToString('x2')) }
    return $sb.ToString()
}

# ---------- routes ----------

function Send-CapstanLibraryIndex {
    param($Context)
    $lib = $script:CapstanLibrary
    $items = New-Object System.Collections.ArrayList
    foreach ($f in (New-Object IO.DirectoryInfo $lib.Root).GetFiles()) {
        if (-not (Test-CapstanLibraryId $f.Name)) { continue }
        if (($f.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
        [void]$items.Add(@{ id = $f.Name; size = $f.Length; modified = $f.LastWriteTimeUtc.ToString('yyyy-MM-ddTHH:mm:ss.fffZ') })
    }
    $sorted = @($items | Sort-Object -Property @{ Expression = { $_.modified }; Descending = $true })
    Send-Json $Context @{ files = $sorted; count = $sorted.Count }
}

function Start-CapstanLibraryUpload {
    param($Context)
    $lib = $script:CapstanLibrary
    $read = Read-CapstanLibraryJson $Context.Request
    if (-not $read.ok) { Send-CapstanLibraryError $Context $read.status $read.code $read.message; return }
    $body = $read.value
    if ($null -eq $body) { Send-CapstanLibraryError $Context 400 'bad_json' 'The body must be a JSON object'; return }
    $id = Get-CapstanLibraryProp $body 'id'
    if ($id -isnot [string] -or -not (Test-CapstanLibraryId $id)) { Send-CapstanLibraryError $Context 400 'bad_id' 'The id must be 1 to 80 characters of a-z, 0-9, _ or -'; return }
    $size = Get-CapstanLibraryProp $body 'size'
    if (-not (Test-CapstanWholeNumber $size) -or $size -lt 1) { Send-CapstanLibraryError $Context 400 'bad_size' 'The size must be a whole number of bytes, at least 1'; return }
    $size = [long]$size
    if ($size -gt $lib.MaxFileBytes) { Send-CapstanLibraryError $Context 413 'too_large' 'The file is larger than the library accepts'; return }
    $sha = Get-CapstanLibraryProp $body 'sha256'
    if ($null -ne $sha) {
        if ($sha -isnot [string] -or $sha -notmatch '^[0-9a-fA-F]{64}\z') { Send-CapstanLibraryError $Context 400 'bad_sha256' 'sha256 must be 64 hexadecimal characters'; return }
        $sha = $sha.ToLowerInvariant()
    }
    $chunk = Get-CapstanLibraryProp $body 'chunkSize'
    if ($null -eq $chunk) { $chunk = $lib.ChunkMax }
    elseif (-not (Test-CapstanWholeNumber $chunk) -or $chunk -lt $lib.ChunkMin -or $chunk -gt $lib.ChunkMax) {
        Send-CapstanLibraryError $Context 400 'bad_chunk' ('chunkSize must be between ' + $lib.ChunkMin + ' and ' + $lib.ChunkMax); return
    }
    $chunk = [long]$chunk
    $count = [int][Math]::Ceiling($size / [double]$chunk)

    $existing = $lib.Active[$id]
    if ($null -ne $existing) {
        # Same upload again (a reload, a retry): hand back what already arrived so only the rest is sent.
        if ($existing.Size -ne $size -or $existing.Chunk -ne $chunk -or ($sha -and $existing.Sha256 -and $existing.Sha256 -ne $sha)) {
            Send-CapstanLibraryError $Context 409 'upload_exists' 'An upload of this id is under way with different settings; delete it first'; return
        }
        $existing.Last = [DateTime]::UtcNow
        if ($sha -and -not $existing.Sha256) { $existing.Sha256 = $sha }
        $got = New-Object System.Collections.ArrayList
        for ($i = 0; $i -lt $count; $i++) { if ($existing.Received[$i]) { [void]$got.Add($i) } }
        Send-Json $Context @{ id = $id; size = $size; chunkSize = $chunk; parts = $count; received = @($got); resumed = $true }
        return
    }
    if ($lib.Active.Count -ge $lib.MaxUploads) { Send-CapstanLibraryError $Context 429 'too_many_uploads' 'Too many uploads are under way; try again shortly'; return }
    if (-not (Test-CapstanLibraryRoom $size $id)) { Send-CapstanLibraryError $Context 507 'no_space' 'Not enough free disk space for this file'; return }
    $temp = Resolve-CapstanLibraryTemp $id
    if ($null -eq $temp) { Send-CapstanLibraryError $Context 400 'bad_id' 'The id is not acceptable'; return }
    try {
        $fs = [IO.FileStream]::new($temp, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $fs.Dispose()
    } catch { Send-CapstanLibraryError $Context 500 'disk_error' 'The library could not start the upload'; return }
    $hasher = $null
    if ($sha) { $hasher = New-Object System.Security.Cryptography.SHA256CryptoServiceProvider }
    $lib.Active[$id] = @{
        Id = $id; Size = $size; Chunk = $chunk; Count = $count; Sha256 = $sha; Temp = $temp
        Received = [bool[]]::new($count); ReceivedCount = 0; Last = [DateTime]::UtcNow
        Hasher = $hasher; HashValid = $true; NextHash = 0
    }
    Send-Json $Context @{ id = $id; size = $size; chunkSize = $chunk; parts = $count; received = @(); resumed = $false }
}

function Save-CapstanLibraryPart {
    # Writes one chunk at part * chunkSize in 1 MB buffers. Throws when the body ends early.
    param($Upload, [int]$Part, $Body, [long]$Expected)
    $track = ($null -ne $Upload.Hasher) -and $Upload.HashValid -and ($Part -eq $Upload.NextHash) -and (-not $Upload.Received[$Part])
    # Rewriting a part, or writing out of order, means the running hash no longer matches the file.
    if ($null -ne $Upload.Hasher -and -not $track) { $Upload.HashValid = $false }
    $fs = [IO.FileStream]::new($Upload.Temp, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::None, 1048576)
    try {
        [void]$fs.Seek([long]$Part * $Upload.Chunk, [IO.SeekOrigin]::Begin)
        $buffer = New-Object byte[] 1048576
        $done = 0L
        while ($done -lt $Expected) {
            $want = [int][Math]::Min(1048576L, $Expected - $done)
            $got = $Body.Read($buffer, 0, $want)
            if ($got -le 0) { throw [IO.IOException]::new('Incomplete request body') }
            $fs.Write($buffer, 0, $got)
            if ($track) { [void]$Upload.Hasher.TransformBlock($buffer, 0, $got, $null, 0) }
            $done += $got
        }
        $fs.Flush()
    } catch {
        if ($track) { $Upload.HashValid = $false }
        throw
    } finally { $fs.Dispose() }
    if ($track) { $Upload.NextHash = $Part + 1 }
}

function Receive-CapstanLibraryPart {
    param($Context, [string]$Id)
    $lib = $script:CapstanLibrary
    $request = $Context.Request
    $upload = $lib.Active[$Id]
    if ($null -eq $upload) { Send-CapstanLibraryError $Context 404 'no_upload' 'No upload is under way for this id'; return }
    $ct = ([string]$request.Headers['Content-Type']).Split(';')[0].Trim().ToLowerInvariant()
    if ($ct -ne 'application/octet-stream') { Send-CapstanLibraryError $Context 415 'content_type' 'Content-Type must be application/octet-stream'; return }
    $partText = [string]$request.QueryString['part']
    if ($partText -notmatch '^[0-9]{1,9}\z' -or [int]$partText -ge $upload.Count) { Send-CapstanLibraryError $Context 400 'bad_part' 'part must be a number below the part count'; return }
    $part = [int]$partText
    if ($request.ContentLength64 -gt $lib.ChunkMax) { Send-CapstanLibraryError $Context 413 'chunk_too_large' 'A chunk is at most 8 MB'; return }
    $expected = if ($part -lt $upload.Count - 1) { $upload.Chunk } else { $upload.Size - ([long]$part * $upload.Chunk) }
    if ($request.ContentLength64 -ne $expected) { Send-CapstanLibraryError $Context 400 'bad_part_length' 'The chunk has the wrong length for this part'; return }
    $upload.Last = [DateTime]::UtcNow
    try {
        Save-CapstanLibraryPart $upload $part $request.InputStream $expected
    } catch {
        Send-CapstanLibraryError $Context 400 'upload_interrupted' 'The chunk did not arrive completely; send this part again'
        return
    }
    if (-not $upload.Received[$part]) { $upload.Received[$part] = $true; $upload.ReceivedCount++ }
    $upload.Last = [DateTime]::UtcNow
    Send-Json $Context @{ ok = $true; part = $part; received = $upload.ReceivedCount; parts = $upload.Count }
}

function Complete-CapstanLibraryUpload {
    param($Context, [string]$Id)
    $lib = $script:CapstanLibrary
    $upload = $lib.Active[$Id]
    if ($null -eq $upload) { Send-CapstanLibraryError $Context 404 'no_upload' 'No upload is under way for this id'; return }
    $read = Read-CapstanLibraryJson $Context.Request
    if (-not $read.ok) { Send-CapstanLibraryError $Context $read.status $read.code $read.message; return }
    $given = Get-CapstanLibraryProp $read.value 'sha256'
    if ($null -ne $given) {
        if ($given -isnot [string] -or $given -notmatch '^[0-9a-fA-F]{64}\z') { Send-CapstanLibraryError $Context 400 'bad_sha256' 'sha256 must be 64 hexadecimal characters'; return }
        $given = $given.ToLowerInvariant()
        if ($upload.Sha256 -and $upload.Sha256 -ne $given) { Send-CapstanLibraryError $Context 400 'bad_sha256' 'sha256 differs from the one given at the start'; return }
        $upload.Sha256 = $given
    }
    $upload.Last = [DateTime]::UtcNow
    if ($upload.ReceivedCount -ne $upload.Count) {
        $missing = New-Object System.Collections.ArrayList
        for ($i = 0; $i -lt $upload.Count -and $missing.Count -lt 100; $i++) { if (-not $upload.Received[$i]) { [void]$missing.Add($i) } }
        Send-Json $Context @{ error = 'Parts are missing'; code = 'incomplete'; missing = @($missing) } 409
        return
    }
    try { $length = ([IO.FileInfo]$upload.Temp).Length } catch { $length = -1 }
    if ($length -ne $upload.Size) {
        Remove-CapstanLibraryUpload $Id
        Send-CapstanLibraryError $Context 409 'size_mismatch' 'The stored size does not match the announced size; start the upload again'
        return
    }
    $actual = $null
    if ($upload.Sha256) {
        Enter-CapstanLibraryJob
        try {
            if ($null -ne $upload.Hasher -and $upload.HashValid -and $upload.NextHash -eq $upload.Count) {
                [void]$upload.Hasher.TransformFinalBlock((New-Object byte[] 0), 0, 0)
                $actual = ConvertTo-CapstanHex $upload.Hasher.Hash
            } else {
                $actual = Get-CapstanFileSha256 $upload.Temp
            }
        } catch {
            Remove-CapstanLibraryUpload $Id
            Send-CapstanLibraryError $Context 500 'disk_error' 'The library could not check the file'
            return
        } finally { Exit-CapstanLibraryJob }
        if ($actual -ne $upload.Sha256) {
            Remove-CapstanLibraryUpload $Id
            Send-CapstanLibraryError $Context 422 'checksum_mismatch' 'The file does not match its SHA-256; it was discarded'
            return
        }
    }
    $final = Resolve-CapstanLibraryFile $Id
    if ($null -eq $final) { Remove-CapstanLibraryUpload $Id; Send-CapstanLibraryError $Context 400 'bad_id' 'The id is not acceptable'; return }
    try {
        if ($null -ne $upload.Hasher) { $upload.Hasher.Dispose(); $upload.Hasher = $null }
        if ([IO.File]::Exists($final)) { [IO.File]::Replace($upload.Temp, $final, [NullString]::Value) } else { [IO.File]::Move($upload.Temp, $final) }
    } catch {
        Remove-CapstanLibraryUpload $Id
        Send-CapstanLibraryError $Context 500 'disk_error' 'The library could not store the file'
        return
    }
    $lib.Active.Remove($Id)
    $payload = @{ ok = $true; id = $Id; size = $upload.Size }
    if ($actual) { $payload.sha256 = $actual }
    Send-Json $Context $payload
}

function Remove-CapstanLibraryEntry {
    param($Context, [string]$Id)
    $lib = $script:CapstanLibrary
    $uploadOnly = ([string]$Context.Request.QueryString['upload'] -ne '')
    $removed = $false
    if ($null -ne $lib.Active[$Id]) { Remove-CapstanLibraryUpload $Id; $removed = $true }
    if (-not $uploadOnly) {
        $path = Resolve-CapstanLibraryFile $Id
        if ($null -ne $path -and [IO.File]::Exists($path)) {
            try { [IO.File]::Delete($path); $removed = $true }
            catch { Send-CapstanLibraryError $Context 500 'disk_error' 'The library could not remove the file'; return }
        }
    }
    if (-not $removed) { Send-CapstanLibraryError $Context 404 'not_found' 'Nothing to remove for this id'; return }
    Send-Json $Context @{ ok = $true; id = $Id }
}

function Get-CapstanLibraryRange {
    <# Parses Range: bytes=a-b | a- | -n against a file length. Returns @{ ok; start; count } ; ok=$false means 416. #>
    param([string]$Header, [long]$Length)
    $m = [regex]::Match($Header, '^bytes=([0-9]{0,18})-([0-9]{0,18})\z')
    if (-not $m.Success) { return @{ ok = $false } }
    $first = $m.Groups[1].Value
    $last = $m.Groups[2].Value
    if ($first -eq '' -and $last -eq '') { return @{ ok = $false } }
    if ($first -eq '') {
        $n = [long]$last
        if ($n -le 0 -or $Length -le 0) { return @{ ok = $false } }
        $start = [Math]::Max(0L, $Length - $n)
        return @{ ok = $true; start = $start; count = $Length - $start }
    }
    $start = [long]$first
    if ($start -ge $Length) { return @{ ok = $false } }
    $end = $Length - 1
    if ($last -ne '') {
        $end = [Math]::Min([long]$last, $Length - 1)
        if ($end -lt $start) { return @{ ok = $false } }
    }
    return @{ ok = $true; start = $start; count = $end - $start + 1 }
}

function Send-CapstanLibraryFile {
    param($Context, [string]$Id)
    $path = Resolve-CapstanLibraryFile $Id
    if ($null -eq $path -or -not [IO.File]::Exists($path)) { Send-CapstanLibraryError $Context 404 'not_found' 'No such file in the library'; return }
    try {
        $fs = [IO.FileStream]::new($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read, 1048576, [IO.FileOptions]::SequentialScan)
    } catch { Send-CapstanLibraryError $Context 500 'disk_error' 'The library could not open the file'; return }
    $length = $fs.Length
    $response = $Context.Response
    $rangeHeader = [string]$Context.Request.Headers['Range']
    $start = 0L; $count = $length; $status = 200
    if ($rangeHeader) {
        $range = Get-CapstanLibraryRange $rangeHeader $length
        if (-not $range.ok) {
            $fs.Dispose()
            $response.Headers.Add('Content-Range', ('bytes */' + $length))
            Send-CapstanLibraryError $Context 416 'bad_range' 'The requested range cannot be served'
            return
        }
        $start = $range.start; $count = $range.count; $status = 206
        $response.Headers.Add('Content-Range', ('bytes ' + $start + '-' + ($start + $count - 1) + '/' + $length))
    }
    if ($start -gt 0) { [void]$fs.Seek($start, [IO.SeekOrigin]::Begin) }
    # The host's shared helpers: Set-CapstanResponseHeaders (status, type and the security headers) and
    # Response.SetStream, which sends exactly $count bytes from the stream's current position (after the
    # Seek above, so a ranged download carries precisely the bytes asked for) and closes the file.
    try {
        Set-CapstanResponseHeaders $response 'application/octet-stream' $status
        $response.Headers.Add('Accept-Ranges', 'bytes')
        $response.Headers.Add('Content-Disposition', 'attachment; filename="' + $Id + '"')
        $response.ContentLength64 = $count
        $response.SetStream($fs, $count)
    } catch { $fs.Dispose(); throw }
    # Close() streams the bytes; a host job holds the auto-stop while a big file goes out.
    Enter-CapstanLibraryJob
    try { $response.Close() } finally { Exit-CapstanLibraryJob }
}

function Invoke-CapstanLibraryRoute {
    <#
      Called by the host after its Host, Origin and Sec-Fetch-Site checks. Returns $true when the path belongs
      to the library (the response has been sent), $false for any other path. Checks the session token itself.
    #>
    param($Context, [string]$SessionToken)
    $request = $Context.Request
    $path = $request.Url.AbsolutePath
    $method = $request.HttpMethod
    $match = [regex]::Match($path, '^/api/files(?:/([^/]*?)(?:/(complete))?)?\z')
    if (-not $match.Success) {
        if ($path -eq '/api/files' -or $path.StartsWith('/api/files/', [StringComparison]::Ordinal)) {
            if (-not (Test-CapstanTokenEqual ([string]$request.Headers['X-Capstan-Token']) $SessionToken)) { Send-Json $Context @{ error = 'Invalid session' } 403; return $true }
            Send-CapstanLibraryError $Context 404 'not_found' 'Route not found'
            return $true
        }
        return $false
    }
    if (-not (Test-CapstanTokenEqual ([string]$request.Headers['X-Capstan-Token']) $SessionToken)) { Send-Json $Context @{ error = 'Invalid session' } 403; return $true }
    if ($null -eq $script:CapstanLibrary) { Send-CapstanLibraryError $Context 404 'library_off' 'The on-disk library is not available'; return $true }
    Invoke-CapstanLibrarySweep
    $id = $match.Groups[1].Value
    $hasId = $match.Groups[1].Success
    $complete = $match.Groups[2].Success
    try {
        if (-not $hasId) {
            if ($method -eq 'GET') { Send-CapstanLibraryIndex $Context }
            elseif ($method -eq 'POST') { Start-CapstanLibraryUpload $Context }
            else { Send-CapstanLibraryError $Context 405 'method' 'Method not allowed' }
            return $true
        }
        if (-not (Test-CapstanLibraryId $id)) { Send-CapstanLibraryError $Context 400 'bad_id' 'The id must be 1 to 80 characters of a-z, 0-9, _ or -'; return $true }
        if ($complete) {
            if ($method -eq 'POST') { Complete-CapstanLibraryUpload $Context $id } else { Send-CapstanLibraryError $Context 405 'method' 'Method not allowed' }
            return $true
        }
        switch ($method) {
            'PUT' { Receive-CapstanLibraryPart $Context $id }
            'GET' { Send-CapstanLibraryFile $Context $id }
            'DELETE' { Remove-CapstanLibraryEntry $Context $id }
            default { Send-CapstanLibraryError $Context 405 'method' 'Method not allowed' }
        }
    } catch {
        # No exception text: it can carry the user's folder names.
        Write-Warning ('Library request failed (' + $_.Exception.GetType().Name + ')')
        try { Send-CapstanLibraryError $Context 500 'failed' 'The library request failed' } catch { }
    }
    return $true
}
