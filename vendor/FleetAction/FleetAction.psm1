# FleetAction.psm1
# Fleet CLI/API action framework baseline 1.0.0.
# MIT License. Copyright (c) 2026 Data Crucible Team for Fleethacker.

Set-StrictMode -Version 3.0

$script:FleetVersion = '1.0.0'
$script:FleetInternalMessage = 'An internal error occurred.'
$script:FleetMaxBodyBytes = 1048576
$script:FleetMaxArgString = 65536
$script:FleetMaxArgs = 32
$script:FleetNamePattern = '^[a-z][a-z0-9-]{0,62}$'
$script:FleetArgNamePattern = '^[A-Za-z_][A-Za-z0-9_-]{0,63}$'
$script:FleetRegistry = New-Object System.Collections.Specialized.OrderedDictionary

function Test-FleetWindows {
    if ($PSVersionTable.PSVersion.Major -lt 6) {
        return $true
    }
    return [bool]$IsWindows
}

function Get-FleetJoinedPath {
    param([Parameter(Mandatory = $true)][string[]]$Parts)
    $path = $Parts[0]
    $index = 1
    while ($index -lt $Parts.Count) {
        $path = Join-Path -Path $path -ChildPath $Parts[$index]
        $index++
    }
    return $path
}

function Test-FleetHasProperty {
    param($Object, [string]$Name)
    if ($null -eq $Object) {
        return $false
    }
    if ($Object -is [string]) {
        return $false
    }
    if ($Object -is [System.Collections.IDictionary]) {
        foreach ($key in @($Object.Keys)) {
            if ([string]$key -ceq $Name) {
                return $true
            }
        }
        return $false
    }
    $property = $Object.PSObject.Properties[$Name]
    return ($null -ne $property)
}

function Get-FleetProperty {
    param($Object, [string]$Name)
    if (-not (Test-FleetHasProperty -Object $Object -Name $Name)) {
        return $null
    }
    if ($Object -is [System.Collections.IDictionary]) {
        return $Object[$Name]
    }
    return $Object.PSObject.Properties[$Name].Value
}

function Get-FleetPropertyNames {
    param($Object)
    $names = New-Object System.Collections.Generic.List[string]
    if ($null -eq $Object) {
        return $names
    }
    if ($Object -is [System.Collections.IDictionary]) {
        foreach ($key in @($Object.Keys)) {
            $names.Add([string]$key)
        }
        return $names
    }
    foreach ($property in @($Object.PSObject.Properties)) {
        $names.Add([string]$property.Name)
    }
    return $names
}

function Remove-FleetProperty {
    param($Object, [string]$Name)
    if ($null -eq $Object) {
        return
    }
    if ($Object -is [System.Collections.IDictionary]) {
        $found = $null
        foreach ($key in @($Object.Keys)) {
            if ([string]$key -ceq $Name) {
                $found = $key
            }
        }
        if ($null -ne $found) {
            [void]$Object.Remove($found)
        }
        return
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -ne $property) {
        [void]$Object.PSObject.Properties.Remove($Name)
    }
}

function Test-FleetIsList {
    param($Value)
    if ($null -eq $Value) {
        return $false
    }
    if ($Value -is [string]) {
        return $false
    }
    if ($Value -is [System.Collections.IDictionary]) {
        return $false
    }
    return $Value -is [System.Collections.IList]
}

function Test-FleetIsNumber {
    param($Value)
    if ($null -eq $Value) {
        return $false
    }
    return ($Value -is [byte] -or $Value -is [int] -or $Value -is [long] -or $Value -is [decimal] -or $Value -is [double] -or $Value -is [float] -or $Value -is [single])
}

function Test-FleetIsInteger {
    param($Value)
    if ($Value -is [byte] -or $Value -is [int] -or $Value -is [long]) {
        return $true
    }
    if ($Value -is [decimal]) {
        return ($Value -eq [decimal]::Truncate($Value))
    }
    if ($Value -is [double] -or $Value -is [float] -or $Value -is [single]) {
        $number = [double]$Value
        if ([double]::IsNaN($number) -or [double]::IsInfinity($number)) {
            return $false
        }
        return ($number -eq [Math]::Floor($number))
    }
    return $false
}

function Test-FleetScalar {
    param($Value)
    if ($null -eq $Value) {
        return $true
    }
    if ($Value -is [string] -or $Value -is [bool]) {
        return $true
    }
    return (Test-FleetIsNumber -Value $Value)
}

function Test-FleetSameValue {
    param($Left, $Right)
    if ($null -eq $Left -and $null -eq $Right) {
        return $true
    }
    if ($null -eq $Left -or $null -eq $Right) {
        return $false
    }
    if ((Test-FleetIsNumber -Value $Left) -and (Test-FleetIsNumber -Value $Right)) {
        return (([double]$Left) -eq ([double]$Right))
    }
    if (($Left -is [bool]) -or ($Right -is [bool])) {
        return (($Left -is [bool]) -and ($Right -is [bool]) -and ($Left -eq $Right))
    }
    return (([string]$Left) -eq ([string]$Right))
}

function ConvertTo-FleetEscapedString {
    param([string]$Text)
    return (ConvertTo-Json -InputObject $Text -Depth 30 -Compress)
}

function ConvertTo-FleetJsonValue {
    param($Value, [int]$Depth)
    if ($Depth -lt 0) {
        return 'null'
    }
    if ($null -eq $Value) {
        return 'null'
    }
    if ($Value -is [bool]) {
        if ($Value) {
            return 'true'
        }
        return 'false'
    }
    if ($Value -is [string]) {
        return (ConvertTo-FleetEscapedString -Text $Value)
    }
    if (Test-FleetIsNumber -Value $Value) {
        if (Test-FleetIsInteger -Value $Value) {
            return ([System.Convert]::ToString($Value, [System.Globalization.CultureInfo]::InvariantCulture))
        }
        return ([double]$Value).ToString('R', [System.Globalization.CultureInfo]::InvariantCulture)
    }
    if (Test-FleetIsList -Value $Value) {
        $parts = New-Object System.Collections.Generic.List[string]
        foreach ($item in @($Value)) {
            $parts.Add((ConvertTo-FleetJsonValue -Value $item -Depth ($Depth - 1)))
        }
        return ('[' + ($parts -join ',') + ']')
    }
    if (($Value -is [System.Collections.IDictionary]) -or ($Value.PSObject -ne $null)) {
        $parts = New-Object System.Collections.Generic.List[string]
        foreach ($name in @(Get-FleetPropertyNames -Object $Value)) {
            $child = Get-FleetProperty -Object $Value -Name $name
            $encodedName = ConvertTo-FleetEscapedString -Text $name
            $encodedValue = ConvertTo-FleetJsonValue -Value $child -Depth ($Depth - 1)
            $parts.Add($encodedName + ':' + $encodedValue)
        }
        return ('{' + ($parts -join ',') + '}')
    }
    return (ConvertTo-FleetEscapedString -Text ([string]$Value))
}

function ConvertTo-FleetJson {
    param($Value)
    $json = ConvertTo-FleetJsonValue -Value $Value -Depth 30
    if (-not $json.EndsWith("`n")) {
        $json = $json + "`n"
    }
    return $json
}

function ConvertTo-FleetRedactedText {
    param([string]$Message)
    if ([string]::IsNullOrEmpty($Message)) {
        return ''
    }
    $clean = [regex]::Replace($Message, '(?i)bearer\s+\S+', 'Bearer [redacted]')
    $clean = [regex]::Replace($clean, '(?i)\b(token|secret|password|authorization|cookie)\b\s*[=:]\s*\S+', '$1=[redacted]')
    return $clean
}

function Write-FleetLog {
    param([string]$Message)
    Write-Verbose (ConvertTo-FleetRedactedText -Message $Message)
}

function New-FleetSuccess {
    param($Result)
    $envelope = New-Object System.Management.Automation.PSObject
    $envelope | Add-Member -MemberType NoteProperty -Name 'v' -Value 1
    $envelope | Add-Member -MemberType NoteProperty -Name 'ok' -Value $true
    $envelope | Add-Member -MemberType NoteProperty -Name 'result' -Value $Result
    return $envelope
}

function New-FleetFailure {
    param(
        [Parameter(Mandatory = $true)][string]$Code,
        [Parameter(Mandatory = $true)][string]$Message,
        [string]$StepId,
        [AllowEmptyCollection()][object[]]$Completed
    )
    $errorObject = New-Object System.Management.Automation.PSObject
    $errorObject | Add-Member -MemberType NoteProperty -Name 'code' -Value $Code
    $errorObject | Add-Member -MemberType NoteProperty -Name 'message' -Value $Message
    if (-not [string]::IsNullOrEmpty($StepId)) {
        $errorObject | Add-Member -MemberType NoteProperty -Name 'stepId' -Value $StepId
    }
    if ($null -ne $Completed) {
        $items = New-Object System.Collections.Generic.List[object]
        foreach ($item in @($Completed)) {
            if ($null -ne $item) {
                $items.Add($item)
            }
        }
        $errorObject | Add-Member -MemberType NoteProperty -Name 'completed' -Value ($items.ToArray())
    }
    $envelope = New-Object System.Management.Automation.PSObject
    $envelope | Add-Member -MemberType NoteProperty -Name 'v' -Value 1
    $envelope | Add-Member -MemberType NoteProperty -Name 'ok' -Value $false
    $envelope | Add-Member -MemberType NoteProperty -Name 'error' -Value $errorObject
    return $envelope
}

function Get-FleetExitCode {
    param($Envelope)
    if ($Envelope.ok) {
        return 0
    }
    $code = [string]$Envelope.error.code
    if ($code -eq 'E_ARGS') { return 2 }
    if ($code -eq 'E_NOT_FOUND') { return 3 }
    if ($code -eq 'E_CONFIRM') { return 4 }
    if ($code -eq 'E_AUTH') { return 5 }
    return 1
}

function Get-FleetHttpStatus {
    param($Envelope)
    if ($Envelope.ok) {
        return 200
    }
    $code = [string]$Envelope.error.code
    if ($code -eq 'E_ARGS') { return 400 }
    if ($code -eq 'E_NOT_FOUND') { return 404 }
    if ($code -eq 'E_CONFIRM') { return 409 }
    if ($code -eq 'E_AUTH') { return 401 }
    return 500
}

function New-FleetCliResult {
    param($Envelope, [bool]$EmitJson, [string]$Text)
    $json = ConvertTo-FleetJson -Value $Envelope
    $result = New-Object System.Management.Automation.PSObject
    $result | Add-Member -MemberType NoteProperty -Name 'ExitCode' -Value (Get-FleetExitCode -Envelope $Envelope)
    $result | Add-Member -MemberType NoteProperty -Name 'Envelope' -Value $Envelope
    $result | Add-Member -MemberType NoteProperty -Name 'Json' -Value $json
    $result | Add-Member -MemberType NoteProperty -Name 'EmitJson' -Value $EmitJson
    if ([string]::IsNullOrEmpty($Text)) {
        if ($Envelope.ok) {
            $Text = 'ok'
        }
        else {
            $Text = ([string]$Envelope.error.code) + ': ' + ([string]$Envelope.error.message)
        }
    }
    $result | Add-Member -MemberType NoteProperty -Name 'Text' -Value $Text
    return $result
}

function Write-FleetOutFile {
    param([string]$Path, [string]$Json)
    if ([string]::IsNullOrEmpty($Path)) {
        return $true
    }
    $parent = Split-Path -Parent $Path
    if (-not [string]::IsNullOrEmpty($parent) -and -not (Test-Path -LiteralPath $parent)) {
        return $false
    }
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($Path, $Json, $utf8)
    return $true
}

function New-FleetErrorRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('E_ARGS', 'E_NOT_FOUND', 'E_CONFIRM', 'E_AUTH')]
        [string]$Code,
        [Parameter(Mandatory = $true)]
        [string]$Message
    )
    $exception = New-Object System.Exception $Message
    [void]$exception.Data.Add('FleetCode', $Code)
    [void]$exception.Data.Add('FleetMessage', $Message)
    throw $exception
}

function Read-FleetJsonFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [int]$MaxBytes = 1048576
    )
    if (-not (Test-Path -LiteralPath $Path)) {
        return @{ Ok = $false; Document = $null; Message = 'JSON file was not found.' }
    }
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -gt $MaxBytes) {
        return @{ Ok = $false; Document = $null; Message = 'JSON file exceeds 1 MB.' }
    }
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    if ($text.Length -gt 0 -and [int][char]$text[0] -eq 0xFEFF) {
        $text = $text.Substring(1)
    }
    if ([string]::IsNullOrWhiteSpace($text)) {
        return @{ Ok = $false; Document = $null; Message = 'Document is not valid JSON.' }
    }
    try {
        $document = $text | ConvertFrom-Json
    }
    catch {
        return @{ Ok = $false; Document = $null; Message = 'Document is not valid JSON.' }
    }
    return @{ Ok = $true; Document = $document; Message = '' }
}

function Get-FleetContractFile {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Name)
    $beside = Join-Path -Path $PSScriptRoot -ChildPath (Join-Path -Path 'contracts' -ChildPath $Name)
    if (Test-Path -LiteralPath $beside) {
        return $beside
    }
    $root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $repo = Get-FleetJoinedPath -Parts @($root, 'contracts', $Name)
    if (Test-Path -LiteralPath $repo) {
        return $repo
    }
    throw ("Contract not found: " + $Name)
}

function Test-FleetSchemaExpectsArray {
    param($Schema)
    if (-not (Test-FleetHasProperty -Object $Schema -Name 'type')) {
        return $false
    }
    $typeSpec = Get-FleetProperty -Object $Schema -Name 'type'
    $names = New-Object System.Collections.Generic.List[string]
    if ($typeSpec -is [string]) {
        $names.Add([string]$typeSpec)
    }
    else {
        foreach ($item in @($typeSpec)) {
            $names.Add([string]$item)
        }
    }
    $expects = $false
    foreach ($name in $names) {
        if ($name -eq 'array') {
            $expects = $true
        }
    }
    return $expects
}

function Add-FleetSchemaErrors {
    param(
        $Errors,
        $Value,
        $Schema,
        [string]$Pointer
    )
    if ($null -eq $Schema) {
        return
    }
    if ([string]::IsNullOrEmpty($Pointer)) {
        $Pointer = ''
    }
    # ConvertFrom-Json turns a one-element array into a bare value. Wrap it back
    # when this schema requires an array and the value is not already a list.
    if ($null -ne $Value -and (Test-FleetSchemaExpectsArray -Schema $Schema) -and -not (Test-FleetIsList -Value $Value)) {
        $otherMatch = $false
        $typeSpec = Get-FleetProperty -Object $Schema -Name 'type'
        $typeNames = New-Object System.Collections.Generic.List[string]
        if ($typeSpec -is [string]) {
            $typeNames.Add([string]$typeSpec)
        }
        else {
            foreach ($item in @($typeSpec)) {
                $typeNames.Add([string]$item)
            }
        }
        foreach ($typeName in $typeNames) {
            if ($typeName -ne 'array' -and (Test-FleetJsonType -Value $Value -TypeName $typeName)) {
                $otherMatch = $true
            }
        }
        if (-not $otherMatch) {
            $Value = @($Value)
        }
    }
    $typeSpec = $null
    if (Test-FleetHasProperty -Object $Schema -Name 'type') {
        $typeSpec = Get-FleetProperty -Object $Schema -Name 'type'
        $typeNames = @()
        if ($typeSpec -is [string]) {
            $typeNames = @([string]$typeSpec)
        }
        else {
            foreach ($item in @($typeSpec)) {
                $typeNames += [string]$item
            }
        }
        $typeOk = $false
        foreach ($typeName in $typeNames) {
            if (Test-FleetJsonType -Value $Value -TypeName $typeName) {
                $typeOk = $true
            }
        }
        if (-not $typeOk) {
            $Errors.Add($Pointer + ' has the wrong type')
        }
    }
    if (Test-FleetHasProperty -Object $Schema -Name 'const') {
        $const = Get-FleetProperty -Object $Schema -Name 'const'
        if (-not (Test-FleetSameValue -Left $Value -Right $const)) {
            $Errors.Add($Pointer + ' has the wrong const value')
        }
    }
    if (Test-FleetHasProperty -Object $Schema -Name 'enum') {
        $enum = @(Get-FleetProperty -Object $Schema -Name 'enum')
        $found = $false
        foreach ($candidate in $enum) {
            if (Test-FleetSameValue -Left $Value -Right $candidate) {
                $found = $true
            }
        }
        if (-not $found) {
            $Errors.Add($Pointer + ' is not in the enum')
        }
    }
    $isObject = Test-FleetJsonType -Value $Value -TypeName 'object'
    $isArray = Test-FleetJsonType -Value $Value -TypeName 'array'
    $isString = ($Value -is [string])
    if ($isString) {
        if (Test-FleetHasProperty -Object $Schema -Name 'minLength') {
            $minLength = [int](Get-FleetProperty -Object $Schema -Name 'minLength')
            if ($Value.Length -lt $minLength) {
                $Errors.Add($Pointer + ' is shorter than minLength')
            }
        }
        if (Test-FleetHasProperty -Object $Schema -Name 'maxLength') {
            $maxLength = [int](Get-FleetProperty -Object $Schema -Name 'maxLength')
            if ($Value.Length -gt $maxLength) {
                $Errors.Add($Pointer + ' is longer than maxLength')
            }
        }
        if (Test-FleetHasProperty -Object $Schema -Name 'pattern') {
            $pattern = [string](Get-FleetProperty -Object $Schema -Name 'pattern')
            if (-not [regex]::IsMatch($Value, $pattern)) {
                $Errors.Add($Pointer + ' does not match the pattern')
            }
        }
    }
    if ((Test-FleetIsNumber -Value $Value)) {
        if (Test-FleetHasProperty -Object $Schema -Name 'minimum') {
            $minimum = [double](Get-FleetProperty -Object $Schema -Name 'minimum')
            if (([double]$Value) -lt $minimum) {
                $Errors.Add($Pointer + ' is below minimum')
            }
        }
        if (Test-FleetHasProperty -Object $Schema -Name 'maximum') {
            $maximum = [double](Get-FleetProperty -Object $Schema -Name 'maximum')
            if (([double]$Value) -gt $maximum) {
                $Errors.Add($Pointer + ' is above maximum')
            }
        }
    }
    if ($isObject) {
        $known = New-Object System.Collections.Generic.List[string]
        $propSchemas = $null
        if (Test-FleetHasProperty -Object $Schema -Name 'properties') {
            $propSchemas = Get-FleetProperty -Object $Schema -Name 'properties'
            foreach ($name in @(Get-FleetPropertyNames -Object $propSchemas)) {
                $known.Add($name)
                if (Test-FleetHasProperty -Object $Value -Name $name) {
                    $childSchema = Get-FleetProperty -Object $propSchemas -Name $name
                    $child = Get-FleetProperty -Object $Value -Name $name
                    $childPointer = $Pointer + '/' + $name
                    Add-FleetSchemaErrors -Errors $Errors -Value $child -Schema $childSchema -Pointer $childPointer
                }
            }
        }
        if (Test-FleetHasProperty -Object $Schema -Name 'required') {
            foreach ($requiredName in @(Get-FleetProperty -Object $Schema -Name 'required')) {
                if (-not (Test-FleetHasProperty -Object $Value -Name ([string]$requiredName))) {
                    $Errors.Add($Pointer + ' is missing required property ' + $requiredName)
                }
            }
        }
        $hasAdditional = Test-FleetHasProperty -Object $Schema -Name 'additionalProperties'
        $additional = $null
        if ($hasAdditional) {
            $additional = Get-FleetProperty -Object $Schema -Name 'additionalProperties'
        }
        foreach ($name in @(Get-FleetPropertyNames -Object $Value)) {
            $isKnown = $false
            foreach ($knownName in $known) {
                if ($knownName -ceq $name) {
                    $isKnown = $true
                }
            }
            if ($isKnown) {
                continue
            }
            if ($hasAdditional -and ($additional -is [bool]) -and (-not $additional)) {
                $Errors.Add($Pointer + ' has unexpected property ' + $name)
            }
            elseif ($hasAdditional -and -not ($additional -is [bool])) {
                $child = Get-FleetProperty -Object $Value -Name $name
                Add-FleetSchemaErrors -Errors $Errors -Value $child -Schema $additional -Pointer ($Pointer + '/' + $name)
            }
        }
    }
    if ($isArray) {
        $items = @($Value)
        if (Test-FleetHasProperty -Object $Schema -Name 'minItems') {
            $minItems = [int](Get-FleetProperty -Object $Schema -Name 'minItems')
            if ($items.Count -lt $minItems) {
                $Errors.Add($Pointer + ' has too few items')
            }
        }
        if (Test-FleetHasProperty -Object $Schema -Name 'maxItems') {
            $maxItems = [int](Get-FleetProperty -Object $Schema -Name 'maxItems')
            if ($items.Count -gt $maxItems) {
                $Errors.Add($Pointer + ' has too many items')
            }
        }
        if (Test-FleetHasProperty -Object $Schema -Name 'items') {
            $itemSchema = Get-FleetProperty -Object $Schema -Name 'items'
            $itemIndex = 0
            foreach ($item in $items) {
                Add-FleetSchemaErrors -Errors $Errors -Value $item -Schema $itemSchema -Pointer ($Pointer + '/' + $itemIndex)
                $itemIndex++
            }
        }
    }
    if (Test-FleetHasProperty -Object $Schema -Name 'oneOf') {
        $branches = @(Get-FleetProperty -Object $Schema -Name 'oneOf')
        $hits = 0
        foreach ($branch in $branches) {
            $local = New-Object System.Collections.Generic.List[string]
            Add-FleetSchemaErrors -Errors $local -Value $Value -Schema $branch -Pointer $Pointer
            if ($local.Count -eq 0) {
                $hits++
            }
        }
        if ($hits -ne 1) {
            $Errors.Add($Pointer + ' must match exactly one subschema')
        }
    }
    if (Test-FleetHasProperty -Object $Schema -Name 'not') {
        $localNot = New-Object System.Collections.Generic.List[string]
        $notSchema = Get-FleetProperty -Object $Schema -Name 'not'
        Add-FleetSchemaErrors -Errors $localNot -Value $Value -Schema $notSchema -Pointer $Pointer
        if ($localNot.Count -eq 0) {
            $Errors.Add($Pointer + ' must not match the excluded subschema')
        }
    }
}

function Test-FleetJsonType {
    param($Value, [string]$TypeName)
    switch ($TypeName) {
        'object' {
            if ($null -eq $Value) { return $false }
            if ($Value -is [string] -or $Value -is [bool] -or (Test-FleetIsNumber -Value $Value)) { return $false }
            if (Test-FleetIsList -Value $Value) { return $false }
            if ($Value -is [System.Collections.IDictionary]) { return $true }
            if ($Value -is [System.Management.Automation.PSCustomObject]) { return $true }
            return $false
        }
        'array' { return (Test-FleetIsList -Value $Value) }
        'string' { return ($Value -is [string]) }
        'boolean' { return ($Value -is [bool]) }
        'null' { return ($null -eq $Value) }
        'number' { return (Test-FleetIsNumber -Value $Value) }
        'integer' { return (Test-FleetIsInteger -Value $Value) }
        default { return $false }
    }
}

function Test-FleetDocument {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Document,
        [string]$SchemaPath,
        [string]$SchemaName
    )
    if ([string]::IsNullOrEmpty($SchemaPath)) {
        if ([string]::IsNullOrEmpty($SchemaName)) {
            return [pscustomobject]@{ Valid = $false; Errors = @('A schema is required.') }
        }
        $SchemaPath = Get-FleetContractFile -Name $SchemaName
    }
    $loaded = Read-FleetJsonFile -Path $SchemaPath -MaxBytes 1048576
    if (-not $loaded.Ok) {
        return [pscustomobject]@{ Valid = $false; Errors = @([string]$loaded.Message) }
    }
    $errors = New-Object System.Collections.Generic.List[string]
    Add-FleetSchemaErrors -Errors $errors -Value $Document -Schema $loaded.Document -Pointer ''
    return [pscustomobject]@{
        Valid  = ($errors.Count -eq 0)
        Errors = $errors.ToArray()
    }
}

function ConvertTo-FleetPublicAction {
    param($Record)
    $parameters = New-Object System.Collections.Generic.List[object]
    foreach ($parameter in @($Record.Parameters)) {
        $copy = New-Object System.Management.Automation.PSObject
        $copy | Add-Member -MemberType NoteProperty -Name 'name' -Value ([string]$parameter.name)
        $copy | Add-Member -MemberType NoteProperty -Name 'type' -Value ([string]$parameter.type)
        $copy | Add-Member -MemberType NoteProperty -Name 'required' -Value ([bool]$parameter.required)
        if (Test-FleetHasProperty -Object $parameter -Name 'description') {
            $description = [string](Get-FleetProperty -Object $parameter -Name 'description')
            if (-not [string]::IsNullOrEmpty($description)) {
                $copy | Add-Member -MemberType NoteProperty -Name 'description' -Value $description
            }
        }
        $parameters.Add($copy)
    }
    $action = New-Object System.Management.Automation.PSObject
    $action | Add-Member -MemberType NoteProperty -Name 'id' -Value ([string]$Record.Id)
    $action | Add-Member -MemberType NoteProperty -Name 'app' -Value ([string]$Record.App)
    $action | Add-Member -MemberType NoteProperty -Name 'noun' -Value ([string]$Record.Noun)
    $action | Add-Member -MemberType NoteProperty -Name 'verb' -Value ([string]$Record.Verb)
    $action | Add-Member -MemberType NoteProperty -Name 'description' -Value ([string]$Record.Description)
    $action | Add-Member -MemberType NoteProperty -Name 'destructive' -Value ([bool]$Record.Destructive)
    $action | Add-Member -MemberType NoteProperty -Name 'parameters' -Value ($parameters.ToArray())
    return $action
}

function Test-FleetRegistryKey {
    param([string]$Key)
    foreach ($existing in @($script:FleetRegistry.Keys)) {
        if ([string]$existing -ceq $Key) {
            return $true
        }
    }
    return $false
}

function Get-FleetActionRecord {
    param([string]$App, [string]$Noun, [string]$Verb)
    $key = $App.ToLowerInvariant() + '|' + $Noun.ToLowerInvariant() + '|' + $Verb.ToLowerInvariant()
    foreach ($existing in @($script:FleetRegistry.Keys)) {
        if ([string]$existing -ceq $key) {
            return $script:FleetRegistry[$existing]
        }
    }
    return $null
}

function Register-FleetAction {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$App,
        [Parameter(Mandatory = $true)][string]$Noun,
        [Parameter(Mandatory = $true)][string]$Verb,
        [Parameter(Mandatory = $true)][scriptblock]$Handler,
        [string]$Description = '',
        [switch]$Destructive,
        [AllowEmptyCollection()][object[]]$Parameters = @()
    )
    $appName = $App.ToLowerInvariant()
    $nounName = $Noun.ToLowerInvariant()
    $verbName = $Verb.ToLowerInvariant()
    if ($appName -notmatch $script:FleetNamePattern) {
        throw 'App name is invalid.'
    }
    if ($nounName -notmatch $script:FleetNamePattern) {
        throw 'Noun is invalid.'
    }
    if ($verbName -notmatch $script:FleetNamePattern) {
        throw 'Verb is invalid.'
    }
    if ($nounName -eq 'commands' -or $nounName -eq 'help' -or $nounName -eq 'job') {
        throw 'Noun is reserved.'
    }
    $key = $appName + '|' + $nounName + '|' + $verbName
    if (Test-FleetRegistryKey -Key $key) {
        throw ('Action already registered: ' + $appName + '.' + $nounName + '.' + $verbName)
    }
    $normalized = New-Object System.Collections.Generic.List[object]
    $seen = New-Object System.Collections.Generic.List[string]
    foreach ($parameter in @($Parameters)) {
        if ($null -eq $parameter) {
            continue
        }
        $name = [string](Get-FleetProperty -Object $parameter -Name 'Name')
        if ([string]::IsNullOrEmpty($name)) {
            $name = [string](Get-FleetProperty -Object $parameter -Name 'name')
        }
        $typeName = [string](Get-FleetProperty -Object $parameter -Name 'Type')
        if ([string]::IsNullOrEmpty($typeName)) {
            $typeName = [string](Get-FleetProperty -Object $parameter -Name 'type')
        }
        if ($name -notmatch $script:FleetArgNamePattern) {
            throw ('Parameter name is invalid: ' + $name)
        }
        if ($typeName -ne 'string' -and $typeName -ne 'number' -and $typeName -ne 'boolean') {
            throw ('Parameter type is invalid: ' + $name)
        }
        foreach ($existingName in $seen) {
            if ($existingName -ceq $name) {
                throw ('Parameter is duplicated: ' + $name)
            }
        }
        $seen.Add($name)
        $required = $false
        if (Test-FleetHasProperty -Object $parameter -Name 'Required') {
            $required = [bool](Get-FleetProperty -Object $parameter -Name 'Required')
        }
        elseif (Test-FleetHasProperty -Object $parameter -Name 'required') {
            $required = [bool](Get-FleetProperty -Object $parameter -Name 'required')
        }
        $copy = New-Object System.Management.Automation.PSObject
        $copy | Add-Member -MemberType NoteProperty -Name 'name' -Value $name
        $copy | Add-Member -MemberType NoteProperty -Name 'type' -Value $typeName
        $copy | Add-Member -MemberType NoteProperty -Name 'required' -Value $required
        $normalized.Add($copy)
    }
    $record = New-Object System.Management.Automation.PSObject
    $record | Add-Member -MemberType NoteProperty -Name 'Id' -Value ($appName + '.' + $nounName + '.' + $verbName)
    $record | Add-Member -MemberType NoteProperty -Name 'App' -Value $appName
    $record | Add-Member -MemberType NoteProperty -Name 'Noun' -Value $nounName
    $record | Add-Member -MemberType NoteProperty -Name 'Verb' -Value $verbName
    $record | Add-Member -MemberType NoteProperty -Name 'Description' -Value $Description
    $record | Add-Member -MemberType NoteProperty -Name 'Destructive' -Value ([bool]$Destructive)
    $record | Add-Member -MemberType NoteProperty -Name 'Parameters' -Value ($normalized.ToArray())
    $record | Add-Member -MemberType NoteProperty -Name 'Handler' -Value $Handler
    $script:FleetRegistry[$key] = $record
    return (ConvertTo-FleetPublicAction -Record $record)
}

function Clear-FleetAction {
    [CmdletBinding()]
    param()
    $script:FleetRegistry.Clear()
}

function Get-FleetAction {
    [CmdletBinding()]
    param(
        [string]$App,
        [string]$Noun,
        [string]$Verb
    )
    $list = New-Object System.Collections.Generic.List[object]
    foreach ($key in @($script:FleetRegistry.Keys)) {
        $record = $script:FleetRegistry[$key]
        $appOk = [string]::IsNullOrEmpty($App) -or ($record.App -ceq $App.ToLowerInvariant())
        $nounOk = [string]::IsNullOrEmpty($Noun) -or ($record.Noun -ceq $Noun.ToLowerInvariant())
        $verbOk = [string]::IsNullOrEmpty($Verb) -or ($record.Verb -ceq $Verb.ToLowerInvariant())
        if ($appOk -and $nounOk -and $verbOk) {
            $list.Add((ConvertTo-FleetPublicAction -Record $record))
        }
    }
    return @($list.ToArray())
}

function ConvertTo-FleetCoercedValue {
    param($Value, [string]$TypeName)
    if ($TypeName -eq 'string') {
        if ($null -eq $Value) {
            return @{ Ok = $true; Value = $null; Message = '' }
        }
        if ($Value -is [string]) {
            return @{ Ok = $true; Value = $Value; Message = '' }
        }
        if ($Value -is [bool]) {
            if ($Value) { return @{ Ok = $true; Value = 'true'; Message = '' } }
            return @{ Ok = $true; Value = 'false'; Message = '' }
        }
        if (Test-FleetIsNumber -Value $Value) {
            $text = [System.Convert]::ToString($Value, [System.Globalization.CultureInfo]::InvariantCulture)
            return @{ Ok = $true; Value = $text; Message = '' }
        }
        return @{ Ok = $false; Value = $null; Message = 'Argument type is not valid.' }
    }
    if ($TypeName -eq 'number') {
        if (Test-FleetIsNumber -Value $Value) {
            return @{ Ok = $true; Value = $Value; Message = '' }
        }
        if ($Value -is [string]) {
            $parsed = 0.0
            $styles = [System.Globalization.NumberStyles]::Float
            $culture = [System.Globalization.CultureInfo]::InvariantCulture
            $ok = [double]::TryParse($Value, $styles, $culture, [ref]$parsed)
            if (-not $ok) {
                return @{ Ok = $false; Value = $null; Message = 'Argument is not a number.' }
            }
            return @{ Ok = $true; Value = $parsed; Message = '' }
        }
        return @{ Ok = $false; Value = $null; Message = 'Argument type is not valid.' }
    }
    if ($TypeName -eq 'boolean') {
        if ($Value -is [bool]) {
            return @{ Ok = $true; Value = $Value; Message = '' }
        }
        if ($Value -is [string] -and $Value -eq 'true') {
            return @{ Ok = $true; Value = $true; Message = '' }
        }
        if ($Value -is [string] -and $Value -eq 'false') {
            return @{ Ok = $true; Value = $false; Message = '' }
        }
        return @{ Ok = $false; Value = $null; Message = 'Argument is not a boolean.' }
    }
    return @{ Ok = $false; Value = $null; Message = 'Argument type is not valid.' }
}

function ConvertTo-FleetArguments {
    param($Record, $Arguments)
    $providedNames = New-Object System.Collections.Generic.List[string]
    $providedValues = New-Object System.Collections.Specialized.OrderedDictionary
    if ($null -ne $Arguments) {
        if (-not (Test-FleetJsonType -Value $Arguments -TypeName 'object')) {
            return @{ Ok = $false; Value = $null; Message = 'Arguments must be an object of scalars.' }
        }
        foreach ($name in @(Get-FleetPropertyNames -Object $Arguments)) {
            if ($providedNames.Count -ge $script:FleetMaxArgs) {
                return @{ Ok = $false; Value = $null; Message = 'Too many arguments.' }
            }
            if ($name -notmatch $script:FleetArgNamePattern) {
                return @{ Ok = $false; Value = $null; Message = ('Unknown argument ''' + $name + '''.') }
            }
            $raw = Get-FleetProperty -Object $Arguments -Name $name
            if (-not (Test-FleetScalar -Value $raw)) {
                return @{ Ok = $false; Value = $null; Message = ('Argument ''' + $name + ''' is not a scalar.') }
            }
            if (($raw -is [string]) -and $raw.Length -gt $script:FleetMaxArgString) {
                return @{ Ok = $false; Value = $null; Message = ('Argument ''' + $name + ''' is too long.') }
            }
            $providedNames.Add($name)
            $providedValues[$name] = $raw
        }
    }
    $declared = @($Record.Parameters)
    foreach ($name in $providedNames) {
        $known = $false
        foreach ($parameter in $declared) {
            if ([string]$parameter.name -ceq $name) {
                $known = $true
            }
        }
        if (-not $known) {
            return @{ Ok = $false; Value = $null; Message = ('Unknown argument ''' + $name + '''.') }
        }
    }
    $coerced = New-Object System.Management.Automation.PSObject
    foreach ($parameter in $declared) {
        $name = [string]$parameter.name
        $present = $false
        foreach ($provided in $providedNames) {
            if ($provided -ceq $name) {
                $present = $true
            }
        }
        if (-not $present) {
            if ([bool]$parameter.required) {
                return @{ Ok = $false; Value = $null; Message = ('Missing argument ''' + $name + '''.') }
            }
            continue
        }
        $rawValue = $providedValues[$name]
        if ($null -eq $rawValue -and [bool]$parameter.required) {
            return @{ Ok = $false; Value = $null; Message = ('Missing argument ''' + $name + '''.') }
        }
        $converted = ConvertTo-FleetCoercedValue -Value $rawValue -TypeName ([string]$parameter.type)
        if (-not $converted.Ok) {
            return @{ Ok = $false; Value = $null; Message = $converted.Message }
        }
        $coerced | Add-Member -MemberType NoteProperty -Name $name -Value $converted.Value
    }
    return @{ Ok = $true; Value = $coerced; Message = '' }
}

function Test-FleetInteractive {
    try {
        if (-not [Environment]::UserInteractive) {
            return $false
        }
        if ([Console]::IsInputRedirected) {
            return $false
        }
        if ([Console]::IsOutputRedirected) {
            return $false
        }
        return $true
    }
    catch {
        return $false
    }
}

function Invoke-FleetAction {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$App,
        [Parameter(Mandatory = $true)][string]$Noun,
        [Parameter(Mandatory = $true)][string]$Verb,
        $Arguments,
        [switch]$Confirmed,
        [switch]$DryRun,
        [switch]$AllowPrompt
    )
    Write-FleetLog -Message ('action ' + $App + '.' + $Noun + '.' + $Verb)
    if ($App.ToLowerInvariant() -notmatch $script:FleetNamePattern -or $Noun.ToLowerInvariant() -notmatch $script:FleetNamePattern -or $Verb.ToLowerInvariant() -notmatch $script:FleetNamePattern) {
        return (New-FleetFailure -Code 'E_ARGS' -Message 'Action name is invalid.')
    }
    $record = Get-FleetActionRecord -App $App -Noun $Noun -Verb $Verb
    if ($null -eq $record) {
        return (New-FleetFailure -Code 'E_NOT_FOUND' -Message 'Action is not registered.')
    }
    $normalized = ConvertTo-FleetArguments -Record $record -Arguments $Arguments
    if (-not $normalized.Ok) {
        return (New-FleetFailure -Code 'E_ARGS' -Message ([string]$normalized.Message))
    }
    if ($DryRun) {
        $preview = New-Object System.Management.Automation.PSObject
        $preview | Add-Member -MemberType NoteProperty -Name 'dryRun' -Value $true
        $preview | Add-Member -MemberType NoteProperty -Name 'actionId' -Value ([string]$record.Id)
        $preview | Add-Member -MemberType NoteProperty -Name 'app' -Value ([string]$record.App)
        $preview | Add-Member -MemberType NoteProperty -Name 'noun' -Value ([string]$record.Noun)
        $preview | Add-Member -MemberType NoteProperty -Name 'verb' -Value ([string]$record.Verb)
        $preview | Add-Member -MemberType NoteProperty -Name 'args' -Value $normalized.Value
        $preview | Add-Member -MemberType NoteProperty -Name 'destructive' -Value ([bool]$record.Destructive)
        $needs = ([bool]$record.Destructive) -and (-not $Confirmed)
        $preview | Add-Member -MemberType NoteProperty -Name 'confirmationRequired' -Value $needs
        return (New-FleetSuccess -Result $preview)
    }
    if (([bool]$record.Destructive) -and (-not $Confirmed)) {
        $accepted = $false
        if ($AllowPrompt -and (Test-FleetInteractive)) {
            Write-Host ('Confirm destructive action ' + $record.Id + '? [y/N]')
            $answer = Read-Host
            if ($answer -eq 'y') {
                $accepted = $true
            }
        }
        if (-not $accepted) {
            return (New-FleetFailure -Code 'E_CONFIRM' -Message 'Confirmation is required for a destructive action.')
        }
    }
    try {
        $value = & $record.Handler $normalized.Value
        return (New-FleetSuccess -Result $value)
    }
    catch {
        $code = $null
        $message = $null
        $exception = $null
        if ($null -ne $_) {
            $exception = $_.Exception
        }
        if ($null -ne $exception -and $null -ne $exception.Data) {
            $code = $exception.Data['FleetCode']
            $message = $exception.Data['FleetMessage']
        }
        if ($code -eq 'E_ARGS' -or $code -eq 'E_NOT_FOUND' -or $code -eq 'E_CONFIRM' -or $code -eq 'E_AUTH') {
            if ([string]::IsNullOrEmpty([string]$message)) {
                $message = 'Request failed.'
            }
            return (New-FleetFailure -Code ([string]$code) -Message ([string]$message))
        }
        return (New-FleetFailure -Code 'E_INTERNAL' -Message $script:FleetInternalMessage)
    }
}

function Get-FleetPriorField {
    param($Prior, [string]$Id, [string]$Field)
    $found = $false
    $result = $null
    foreach ($key in @($Prior.Keys)) {
        if ([string]$key -ceq $Id) {
            $found = $true
            $result = $Prior[$key]
        }
    }
    if (-not $found) {
        return @{ Ok = $false; Value = $null; Message = 'Substitution references a step that has not completed.' }
    }
    if (-not (Test-FleetHasProperty -Object $result -Name $Field)) {
        return @{ Ok = $false; Value = $null; Message = 'Substitution field was not found.' }
    }
    $value = Get-FleetProperty -Object $result -Name $Field
    if (-not (Test-FleetScalar -Value $value)) {
        return @{ Ok = $false; Value = $null; Message = 'Substitution field is not a scalar.' }
    }
    return @{ Ok = $true; Value = $value; Message = '' }
}

function Resolve-FleetArgValue {
    param($Value, $Prior)
    if ($null -eq $Value) {
        return @{ Ok = $true; Value = $null; Message = '' }
    }
    if ($Value -isnot [string]) {
        if (Test-FleetScalar -Value $Value) {
            return @{ Ok = $true; Value = $Value; Message = '' }
        }
        return @{ Ok = $false; Value = $null; Message = 'Arguments must be scalars.' }
    }
    $pattern = '\$\{steps\.([A-Za-z][A-Za-z0-9_-]*)\.result\.([A-Za-z_][A-Za-z0-9_]*)\}'
    $found = [regex]::Matches($Value, $pattern)
    if ($found.Count -eq 0) {
        return @{ Ok = $true; Value = $Value; Message = '' }
    }
    if ($found.Count -eq 1 -and $found[0].Index -eq 0 -and $found[0].Length -eq $Value.Length) {
        return (Get-FleetPriorField -Prior $Prior -Id $found[0].Groups[1].Value -Field $found[0].Groups[2].Value)
    }
    $builder = New-Object System.Text.StringBuilder
    $last = 0
    foreach ($match in $found) {
        if ($match.Index -gt $last) {
            [void]$builder.Append($Value.Substring($last, $match.Index - $last))
        }
        $resolved = Get-FleetPriorField -Prior $Prior -Id $match.Groups[1].Value -Field $match.Groups[2].Value
        if (-not $resolved.Ok) {
            return $resolved
        }
        [void]$builder.Append([string]$resolved.Value)
        $last = $match.Index + $match.Length
    }
    if ($last -lt $Value.Length) {
        [void]$builder.Append($Value.Substring($last))
    }
    return @{ Ok = $true; Value = $builder.ToString(); Message = '' }
}

function Resolve-FleetStepArgs {
    param($Step, $Prior)
    $resolved = New-Object System.Management.Automation.PSObject
    if (-not (Test-FleetHasProperty -Object $Step -Name 'args')) {
        return @{ Ok = $true; Value = $resolved; Message = '' }
    }
    $argsObject = Get-FleetProperty -Object $Step -Name 'args'
    if ($null -eq $argsObject) {
        return @{ Ok = $true; Value = $resolved; Message = '' }
    }
    if (-not (Test-FleetJsonType -Value $argsObject -TypeName 'object')) {
        return @{ Ok = $false; Value = $null; Message = 'Arguments must be an object of scalars.' }
    }
    foreach ($name in @(Get-FleetPropertyNames -Object $argsObject)) {
        $raw = Get-FleetProperty -Object $argsObject -Name $name
        $value = Resolve-FleetArgValue -Value $raw -Prior $Prior
        if (-not $value.Ok) {
            return $value
        }
        $resolved | Add-Member -MemberType NoteProperty -Name $name -Value $value.Value
    }
    return @{ Ok = $true; Value = $resolved; Message = '' }
}

function Invoke-FleetJob {
    [CmdletBinding()]
    param(
        $Job,
        [string]$Path,
        [switch]$Confirmed,
        [switch]$DryRun,
        [switch]$AllowPrompt
    )
    if (-not [string]::IsNullOrEmpty($Path)) {
        $read = Read-FleetJsonFile -Path $Path -MaxBytes $script:FleetMaxBodyBytes
        if (-not $read.Ok) {
            return (New-FleetFailure -Code 'E_ARGS' -Message ([string]$read.Message))
        }
        $Job = $read.Document
    }
    if ($null -eq $Job) {
        return (New-FleetFailure -Code 'E_ARGS' -Message 'Job is required.')
    }
    $localConfirmed = [bool]$Confirmed
    $localDry = [bool]$DryRun
    if (Test-FleetHasProperty -Object $Job -Name 'confirmed') {
        $flag = Get-FleetProperty -Object $Job -Name 'confirmed'
        if ($flag -isnot [bool]) {
            return (New-FleetFailure -Code 'E_ARGS' -Message 'confirmed must be a boolean.')
        }
        if ($flag) {
            $localConfirmed = $true
        }
        Remove-FleetProperty -Object $Job -Name 'confirmed'
    }
    if (Test-FleetHasProperty -Object $Job -Name 'dryRun') {
        $flag = Get-FleetProperty -Object $Job -Name 'dryRun'
        if ($flag -isnot [bool]) {
            return (New-FleetFailure -Code 'E_ARGS' -Message 'dryRun must be a boolean.')
        }
        if ($flag) {
            $localDry = $true
        }
        Remove-FleetProperty -Object $Job -Name 'dryRun'
    }
    $schema = Test-FleetDocument -Document $Job -SchemaName 'job.schema.json'
    if (-not $schema.Valid) {
        $first = 'Job schema validation failed.'
        $schemaErrors = @($schema.Errors)
        if ($schemaErrors.Count -gt 0) {
            $first = 'Job schema validation failed: ' + [string]$schemaErrors[0]
        }
        return (New-FleetFailure -Code 'E_ARGS' -Message $first)
    }
    $steps = @(Get-FleetProperty -Object $Job -Name 'steps')
    $seen = New-Object System.Collections.Generic.List[string]
    foreach ($step in $steps) {
        $id = [string](Get-FleetProperty -Object $step -Name 'id')
        foreach ($existing in $seen) {
            if ($existing -ceq $id) {
                return (New-FleetFailure -Code 'E_ARGS' -Message 'Duplicate step id.')
            }
        }
        $seen.Add($id)
    }
    $completed = New-Object System.Collections.Generic.List[object]
    $prior = New-Object System.Collections.Specialized.OrderedDictionary
    foreach ($step in $steps) {
        $id = [string](Get-FleetProperty -Object $step -Name 'id')
        $stepConfirmed = $localConfirmed
        if (Test-FleetHasProperty -Object $step -Name 'confirmed') {
            $stepFlag = Get-FleetProperty -Object $step -Name 'confirmed'
            if ($stepFlag -eq $true) {
                $stepConfirmed = $true
            }
        }
        $resolved = Resolve-FleetStepArgs -Step $step -Prior $prior
        if (-not $resolved.Ok) {
            return (New-FleetFailure -Code 'E_ARGS' -Message ('Step ''' + $id + ''' failed. ' + [string]$resolved.Message) -StepId $id -Completed ($completed.ToArray()))
        }
        $envelope = Invoke-FleetAction -App ([string](Get-FleetProperty -Object $step -Name 'app')) -Noun ([string](Get-FleetProperty -Object $step -Name 'noun')) -Verb ([string](Get-FleetProperty -Object $step -Name 'verb')) -Arguments $resolved.Value -Confirmed:$stepConfirmed -DryRun:$localDry -AllowPrompt:$AllowPrompt
        if (-not $envelope.ok) {
            return (New-FleetFailure -Code ([string]$envelope.error.code) -Message ('Step ''' + $id + ''' failed. ' + [string]$envelope.error.message) -StepId $id -Completed ($completed.ToArray()))
        }
        $prior[$id] = $envelope.result
        $done = New-Object System.Management.Automation.PSObject
        $done | Add-Member -MemberType NoteProperty -Name 'id' -Value $id
        $done | Add-Member -MemberType NoteProperty -Name 'ok' -Value $true
        $done | Add-Member -MemberType NoteProperty -Name 'result' -Value $envelope.result
        $completed.Add($done)
    }
    $summary = New-Object System.Management.Automation.PSObject
    $summary | Add-Member -MemberType NoteProperty -Name 'steps' -Value ($completed.ToArray())
    return (New-FleetSuccess -Result $summary)
}

function Get-FleetDiscoveryEnvelope {
    param([string]$App)
    $actions = New-Object System.Collections.Generic.List[object]
    foreach ($key in @($script:FleetRegistry.Keys)) {
        $record = $script:FleetRegistry[$key]
        if ($record.App -ceq $App) {
            $actions.Add((ConvertTo-FleetPublicAction -Record $record))
        }
    }
    $sorted = @($actions.ToArray() | Sort-Object -Property id)
    $actionList = New-Object System.Collections.Generic.List[object]
    foreach ($action in $sorted) {
        if ($null -ne $action) {
            $actionList.Add($action)
        }
    }
    $result = New-Object System.Management.Automation.PSObject
    $result | Add-Member -MemberType NoteProperty -Name 'app' -Value $App
    $result | Add-Member -MemberType NoteProperty -Name 'actions' -Value ($actionList.ToArray())
    return (New-FleetSuccess -Result $result)
}

function Format-FleetDiscoveryText {
    param($Envelope)
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('actions:')
    $actions = @(Get-FleetProperty -Object $Envelope.result -Name 'actions')
    foreach ($action in $actions) {
        $line = '  ' + [string]$action.id
        if (-not [string]::IsNullOrEmpty([string]$action.description)) {
            $line = $line + '  ' + [string]$action.description
        }
        if ([bool]$action.destructive) {
            $line = $line + '  destructive'
        }
        $lines.Add($line)
    }
    return ($lines -join "`n")
}

function Read-FleetOptionList {
    param(
        [string[]]$Tokens,
        [int]$Start,
        [bool]$AllowArgs,
        [bool]$AllowFile,
        [bool]$AllowYes,
        [bool]$AllowDry
    )
    $options = @{
        Ok      = $true
        Message = ''
        Json    = $false
        Yes     = $false
        DryRun  = $false
        OutFile = ''
        File    = ''
        Args    = (New-Object System.Collections.Specialized.OrderedDictionary)
    }
    $index = $Start
    while ($index -lt $Tokens.Count) {
        $token = [string]$Tokens[$index]
        if (-not $token.StartsWith('--')) {
            $options.Ok = $false
            $options.Message = 'Unexpected argument.'
            return $options
        }
        $name = ''
        $inline = ''
        $hasInline = $false
        $equals = $token.IndexOf('=')
        if ($equals -ge 0) {
            $name = $token.Substring(2, $equals - 2)
            $inline = $token.Substring($equals + 1)
            $hasInline = $true
        }
        else {
            $name = $token.Substring(2)
        }
        if ($name -ceq 'json') {
            if ($hasInline) {
                $options.Ok = $false
                $options.Message = 'Flag --json does not take a value.'
                return $options
            }
            $options.Json = $true
            $index++
            continue
        }
        if ($name -ceq 'yes') {
            if ((-not $AllowYes) -or $hasInline) {
                $options.Ok = $false
                $options.Message = 'Flag --yes is not valid here.'
                return $options
            }
            $options.Yes = $true
            $index++
            continue
        }
        if ($name -ceq 'dry-run') {
            if ((-not $AllowDry) -or $hasInline) {
                $options.Ok = $false
                $options.Message = 'Flag --dry-run is not valid here.'
                return $options
            }
            $options.DryRun = $true
            $index++
            continue
        }
        if ($name -ceq 'out' -or ($name -ceq 'file' -and $AllowFile)) {
            $value = ''
            if ($hasInline) {
                $value = $inline
                $index++
            }
            else {
                if (($index + 1) -ge $Tokens.Count) {
                    $options.Ok = $false
                    $options.Message = ('Flag --' + $name + ' needs a value.')
                    return $options
                }
                $value = [string]$Tokens[$index + 1]
                if ($value.StartsWith('--')) {
                    $options.Ok = $false
                    $options.Message = ('Flag --' + $name + ' needs a value.')
                    return $options
                }
                $index += 2
            }
            if ($name -ceq 'out') {
                if (-not [string]::IsNullOrEmpty([string]$options.OutFile)) {
                    $options.Ok = $false
                    $options.Message = 'Flag --out was repeated.'
                    return $options
                }
                $options.OutFile = $value
            }
            else {
                if (-not [string]::IsNullOrEmpty([string]$options.File)) {
                    $options.Ok = $false
                    $options.Message = 'Flag --file was repeated.'
                    return $options
                }
                $options.File = $value
            }
            continue
        }
        if ($name -ceq 'file' -and -not $AllowFile) {
            $options.Ok = $false
            $options.Message = 'Flag --file is not valid here.'
            return $options
        }
        if (-not $AllowArgs) {
            $options.Ok = $false
            $options.Message = ('Unknown flag --' + $name + '.')
            return $options
        }
        if ($name -notmatch $script:FleetArgNamePattern) {
            $options.Ok = $false
            $options.Message = ('Unknown flag --' + $name + '.')
            return $options
        }
        $argValue = ''
        if ($hasInline) {
            $argValue = $inline
            $index++
        }
        else {
            if (($index + 1) -ge $Tokens.Count) {
                $options.Ok = $false
                $options.Message = ('Flag --' + $name + ' needs a value.')
                return $options
            }
            $argValue = [string]$Tokens[$index + 1]
            if ($argValue.StartsWith('--')) {
                $options.Ok = $false
                $options.Message = ('Flag --' + $name + ' needs a value.')
                return $options
            }
            $index += 2
        }
        foreach ($existing in @($options.Args.Keys)) {
            if ([string]$existing -ceq $name) {
                $options.Ok = $false
                $options.Message = ('Argument --' + $name + ' was repeated.')
                return $options
            }
        }
        $options.Args[$name] = $argValue
    }
    return $options
}

function Finish-FleetCli {
    param($Envelope, $Options, [string]$Text)
    $emit = [bool]$Options.Json
    $cli = New-FleetCliResult -Envelope $Envelope -EmitJson $emit -Text $Text
    if (-not [string]::IsNullOrEmpty([string]$Options.OutFile)) {
        $wrote = Write-FleetOutFile -Path ([string]$Options.OutFile) -Json $cli.Json
        if (-not $wrote) {
            $failed = New-FleetFailure -Code 'E_ARGS' -Message 'Output path was not found.'
            return (New-FleetCliResult -Envelope $failed -EmitJson $emit -Text '')
        }
    }
    return $cli
}

function Invoke-FleetCli {
    [CmdletBinding()]
    param(
        [AllowEmptyCollection()][string[]]$Arguments
    )
    $tokens = New-Object System.Collections.Generic.List[string]
    if ($null -ne $Arguments) {
        foreach ($token in @($Arguments)) {
            if ($null -ne $token) {
                $tokens.Add([string]$token)
            }
        }
    }
    $usage = 'Usage: <app> commands --json | <app> help --json | <app> <noun> <verb> [--<arg> <value>]... [--json] [--out <file>] [--yes] [--dry-run] | <app> job run --file <job.json> [--json] [--yes] [--dry-run]'
    if ($tokens.Count -lt 2) {
        $failed = New-FleetFailure -Code 'E_ARGS' -Message $usage
        return (New-FleetCliResult -Envelope $failed -EmitJson $false -Text '')
    }
    $app = $tokens[0]
    if ($app -notmatch $script:FleetNamePattern) {
        $failed = New-FleetFailure -Code 'E_ARGS' -Message 'App name is invalid.'
        return (New-FleetCliResult -Envelope $failed -EmitJson $false -Text '')
    }
    $head = $tokens[1]
    if ($head -ceq 'commands' -or $head -ceq 'help') {
        $options = Read-FleetOptionList -Tokens $tokens.ToArray() -Start 2 -AllowArgs $false -AllowFile $false -AllowYes $false -AllowDry $false
        if (-not $options.Ok) {
            $failed = New-FleetFailure -Code 'E_ARGS' -Message ([string]$options.Message)
            return (New-FleetCliResult -Envelope $failed -EmitJson $false -Text '')
        }
        $envelope = Get-FleetDiscoveryEnvelope -App $app
        $text = Format-FleetDiscoveryText -Envelope $envelope
        return (Finish-FleetCli -Envelope $envelope -Options $options -Text $text)
    }
    if ($head -ceq 'job') {
        if ($tokens.Count -lt 3 -or ($tokens[2] -cne 'run')) {
            $failed = New-FleetFailure -Code 'E_ARGS' -Message $usage
            return (New-FleetCliResult -Envelope $failed -EmitJson $false -Text '')
        }
        $options = Read-FleetOptionList -Tokens $tokens.ToArray() -Start 3 -AllowArgs $false -AllowFile $true -AllowYes $true -AllowDry $true
        if (-not $options.Ok) {
            $failed = New-FleetFailure -Code 'E_ARGS' -Message ([string]$options.Message)
            return (New-FleetCliResult -Envelope $failed -EmitJson $false -Text '')
        }
        if ([string]::IsNullOrEmpty([string]$options.File)) {
            $failed = New-FleetFailure -Code 'E_ARGS' -Message 'Flag --file is required.'
            return (New-FleetCliResult -Envelope $failed -EmitJson ([bool]$options.Json) -Text '')
        }
        $prompt = Test-FleetInteractive
        $envelope = Invoke-FleetJob -Path ([string]$options.File) -Confirmed:([bool]$options.Yes) -DryRun:([bool]$options.DryRun) -AllowPrompt:$prompt
        return (Finish-FleetCli -Envelope $envelope -Options $options -Text '')
    }
    if ($tokens.Count -lt 3) {
        $failed = New-FleetFailure -Code 'E_ARGS' -Message $usage
        return (New-FleetCliResult -Envelope $failed -EmitJson $false -Text '')
    }
    $noun = $tokens[1]
    $verb = $tokens[2]
    $options = Read-FleetOptionList -Tokens $tokens.ToArray() -Start 3 -AllowArgs $true -AllowFile $false -AllowYes $true -AllowDry $true
    if (-not $options.Ok) {
        $failed = New-FleetFailure -Code 'E_ARGS' -Message ([string]$options.Message)
        return (New-FleetCliResult -Envelope $failed -EmitJson $false -Text '')
    }
    $prompt = Test-FleetInteractive
    $envelope = Invoke-FleetAction -App $app -Noun $noun -Verb $verb -Arguments $options.Args -Confirmed:([bool]$options.Yes) -DryRun:([bool]$options.DryRun) -AllowPrompt:$prompt
    return (Finish-FleetCli -Envelope $envelope -Options $options -Text '')
}

function Get-FleetAppRoot {
    param([Parameter(Mandatory = $true)][string]$App)
    $name = $App.ToLowerInvariant()
    if ($name -notmatch $script:FleetNamePattern) {
        throw 'App name is invalid.'
    }
    $base = $env:LOCALAPPDATA
    if ([string]::IsNullOrEmpty($base)) {
        if (-not (Test-FleetWindows)) {
            $base = Join-Path -Path $env:HOME -ChildPath '.local/share'
        }
        else {
            throw 'LOCALAPPDATA is not set.'
        }
    }
    return (Get-FleetJoinedPath -Parts @($base, 'FleetHacker', $name))
}

function Set-FleetCurrentUserAcl {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-FleetWindows)) {
        return
    }
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $sid = $identity.User
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    $rights = [System.Security.AccessControl.FileSystemRights]::FullControl
    $inherit = [System.Security.AccessControl.InheritanceFlags]::None
    $propagation = [System.Security.AccessControl.PropagationFlags]::None
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, $rights, $inherit, $propagation, $allow)
    [void]$acl.AddAccessRule($rule)
    [System.IO.File]::SetAccessControl($Path, $acl)
}

function New-FleetSessionToken {
    $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
    try {
        $bytes = New-Object byte[] 32
        $rng.GetBytes($bytes)
    }
    finally {
        $rng.Dispose()
    }
    return (([System.BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant())
}

function ConvertTo-FleetTokenBytes {
    param([Parameter(Mandatory = $true)][string]$Token)
    $raw = [System.Text.Encoding]::UTF8.GetBytes($Token)
    if (-not (Test-FleetWindows)) {
        return $raw
    }
    try {
        Add-Type -AssemblyName System.Security -ErrorAction Stop
        $type = [Type]::GetType('System.Security.Cryptography.ProtectedData, System.Security')
        $scopeType = [Type]::GetType('System.Security.Cryptography.DataProtectionScope, System.Security')
        if ($null -eq $type -or $null -eq $scopeType) {
            return $raw
        }
        $scope = [Enum]::Parse($scopeType, 'CurrentUser')
        $protect = $null
        foreach ($method in @($type.GetMethods())) {
            if ($method.Name -eq 'Protect' -and $method.IsStatic) {
                $parameters = @($method.GetParameters())
                if ($parameters.Length -eq 3) {
                    $protect = $method
                }
            }
        }
        if ($null -eq $protect) {
            return $raw
        }
        $protected = $protect.Invoke($null, @($raw, $null, $scope))
        $magic = [System.Text.Encoding]::ASCII.GetBytes('FHDP')
        $out = New-Object byte[] (4 + $protected.Length)
        [System.Buffer]::BlockCopy($magic, 0, $out, 0, 4)
        [System.Buffer]::BlockCopy($protected, 0, $out, 4, $protected.Length)
        return $out
    }
    catch {
        return $raw
    }
}

function ConvertFrom-FleetTokenBytes {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)
    if ($Bytes.Length -ge 4) {
        $magic = [System.Text.Encoding]::ASCII.GetString($Bytes, 0, 4)
        if ($magic -eq 'FHDP') {
            $payload = New-Object byte[] ($Bytes.Length - 4)
            [System.Buffer]::BlockCopy($Bytes, 4, $payload, 0, $payload.Length)
            Add-Type -AssemblyName System.Security -ErrorAction Stop
            $type = [Type]::GetType('System.Security.Cryptography.ProtectedData, System.Security')
            $scopeType = [Type]::GetType('System.Security.Cryptography.DataProtectionScope, System.Security')
            $scope = [Enum]::Parse($scopeType, 'CurrentUser')
            $unprotect = $null
            foreach ($method in @($type.GetMethods())) {
                if ($method.Name -eq 'Unprotect' -and $method.IsStatic) {
                    $parameters = @($method.GetParameters())
                    if ($parameters.Length -eq 3) {
                        $unprotect = $method
                    }
                }
            }
            $plain = $unprotect.Invoke($null, @($payload, $null, $scope))
            return [System.Text.Encoding]::UTF8.GetString($plain)
        }
    }
    return [System.Text.Encoding]::UTF8.GetString($Bytes)
}

function New-FleetTokenPlaceholder {
    param([Parameter(Mandatory = $true)][string]$Path)
    $directory = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Create, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    $stream.Close()
    if (Test-FleetWindows) {
        Set-FleetCurrentUserAcl -Path $Path
    }
    else {
        try {
            & chmod 700 $directory
            & chmod 600 $Path
        }
        catch {
            Write-FleetLog -Message 'token file mode was not changed'
        }
    }
}

function Write-FleetTokenFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Token
    )
    $bytes = ConvertTo-FleetTokenBytes -Token $Token
    [System.IO.File]::WriteAllBytes($Path, $bytes)
    if (Test-FleetWindows) {
        Set-FleetCurrentUserAcl -Path $Path
    }
}

function Read-FleetSessionToken {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$App)
    $path = Join-Path -Path (Get-FleetAppRoot -App $App) -ChildPath 'session.token'
    if (-not (Test-Path -LiteralPath $path)) {
        throw 'Session token is not present.'
    }
    $bytes = [System.IO.File]::ReadAllBytes($path)
    return (ConvertFrom-FleetTokenBytes -Bytes $bytes)
}

function Test-FleetTokenMatch {
    param([string]$Presented, [string]$Expected)
    if ([string]::IsNullOrEmpty($Expected) -or [string]::IsNullOrEmpty($Presented)) {
        return $false
    }
    $left = [System.Text.Encoding]::UTF8.GetBytes($Presented)
    $right = [System.Text.Encoding]::UTF8.GetBytes($Expected)
    $length = $left.Length
    if ($right.Length -gt $length) {
        $length = $right.Length
    }
    $diff = $left.Length -bxor $right.Length
    $index = 0
    while ($index -lt $length) {
        $ca = 0
        $cb = 0
        if ($index -lt $left.Length) {
            $ca = [int]$left[$index]
        }
        if ($index -lt $right.Length) {
            $cb = [int]$right[$index]
        }
        $diff = $diff -bor ($ca -bxor $cb)
        $index++
    }
    return ($diff -eq 0)
}

function ConvertTo-FleetHeaderMap {
    param($Headers)
    $map = New-Object System.Collections.Hashtable ([System.StringComparer]::OrdinalIgnoreCase)
    if ($null -eq $Headers) {
        return $map
    }
    if ($Headers -is [System.Collections.IDictionary]) {
        foreach ($key in @($Headers.Keys)) {
            $map[[string]$key] = [string]$Headers[$key]
        }
    }
    return $map
}

function Get-FleetPresentedToken {
    param($HeaderMap)
    $authorization = [string]$HeaderMap['Authorization']
    if (-not [string]::IsNullOrEmpty($authorization)) {
        $prefix = 'Bearer '
        if ($authorization.StartsWith($prefix)) {
            return $authorization.Substring($prefix.Length)
        }
        return ''
    }
    $cookie = [string]$HeaderMap['Cookie']
    if ([string]::IsNullOrEmpty($cookie)) {
        return ''
    }
    foreach ($part in $cookie.Split(';')) {
        $trimmed = $part.Trim()
        $equals = $trimmed.IndexOf('=')
        if ($equals -lt 1) {
            continue
        }
        $name = $trimmed.Substring(0, $equals).Trim()
        if ($name -ceq 'FleetSession') {
            return $trimmed.Substring($equals + 1).Trim()
        }
    }
    return ''
}

function Resolve-FleetRoute {
    param([string]$Path)
    $route = $Path
    if ([string]::IsNullOrEmpty($route)) {
        $route = '/'
    }
    $query = $route.IndexOf('?')
    if ($query -ge 0) {
        $route = $route.Substring(0, $query)
    }
    if ($route.Length -gt 1 -and $route.EndsWith('/')) {
        $route = $route.Substring(0, $route.Length - 1)
    }
    if ($route -ceq '/__fleethacker/id') {
        return @{ Kind = 'id' }
    }
    if ($route -ceq '/') {
        return @{ Kind = 'home' }
    }
    if ($route -ceq '/api/v1/actions') {
        return @{ Kind = 'actions' }
    }
    if ($route -ceq '/api/v1/job') {
        return @{ Kind = 'job' }
    }
    $prefix = '/api/v1/'
    if ($route.StartsWith($prefix)) {
        $rest = $route.Substring($prefix.Length)
        $parts = $rest.Split('/')
        if ($parts.Length -eq 3) {
            return @{
                Kind = 'action'
                App  = $parts[0].ToLowerInvariant()
                Noun = $parts[1].ToLowerInvariant()
                Verb = $parts[2].ToLowerInvariant()
            }
        }
    }
    return @{ Kind = 'missing' }
}

function New-FleetHttpResult {
    param(
        [int]$StatusCode,
        [string]$Body,
        [string]$ContentType,
        [bool]$SetCookie
    )
    $result = New-Object System.Management.Automation.PSObject
    $result | Add-Member -MemberType NoteProperty -Name 'StatusCode' -Value $StatusCode
    $result | Add-Member -MemberType NoteProperty -Name 'Body' -Value $Body
    $result | Add-Member -MemberType NoteProperty -Name 'ContentType' -Value $ContentType
    $result | Add-Member -MemberType NoteProperty -Name 'SetCookie' -Value $SetCookie
    return $result
}

function Read-FleetLimitedBody {
    param(
        [long]$ContentLength,
        [string]$TransferEncoding,
        [scriptblock]$OpenBody
    )
    if (-not [string]::IsNullOrEmpty($TransferEncoding) -and ($TransferEncoding.ToLowerInvariant().IndexOf('chunked') -ge 0)) {
        return @{ Ok = $false; Text = ''; Code = 'E_ARGS'; Message = 'Chunked transfer is not allowed.' }
    }
    if ($ContentLength -lt 0) {
        return @{ Ok = $false; Text = ''; Code = 'E_ARGS'; Message = 'Content-Length is required.' }
    }
    if ($ContentLength -gt $script:FleetMaxBodyBytes) {
        return @{ Ok = $false; Text = ''; Code = 'E_ARGS'; Message = 'Request body exceeds 1 MB.' }
    }
    if ($ContentLength -eq 0) {
        return @{ Ok = $true; Text = ''; Code = ''; Message = '' }
    }
    if ($null -eq $OpenBody) {
        return @{ Ok = $false; Text = ''; Code = 'E_INTERNAL'; Message = $script:FleetInternalMessage }
    }
    $text = & $OpenBody ([int]$ContentLength)
    if ($null -eq $text) {
        $text = ''
    }
    $byteCount = [System.Text.Encoding]::UTF8.GetByteCount([string]$text)
    if ($byteCount -gt $script:FleetMaxBodyBytes) {
        return @{ Ok = $false; Text = ''; Code = 'E_ARGS'; Message = 'Request body exceeds 1 MB.' }
    }
    return @{ Ok = $true; Text = [string]$text; Code = ''; Message = '' }
}

function Invoke-FleetHttpPipeline {
    param(
        [Parameter(Mandatory = $true)][string]$App,
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$Token,
        [Parameter(Mandatory = $true)][string]$Method,
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$Query = '',
        $Headers,
        [long]$ContentLength = -1,
        [string]$TransferEncoding = '',
        [scriptblock]$OpenBody
    )
    $methodName = $Method.ToUpperInvariant()
    $headerMap = ConvertTo-FleetHeaderMap -Headers $Headers
    $hostHeader = [string]$headerMap['Host']
    $allowedHost = ($hostHeader -ceq '127.0.0.1') -or ($hostHeader -ceq ('127.0.0.1:' + $Port))
    if (-not $allowedHost) {
        $envelope = New-FleetFailure -Code 'E_AUTH' -Message 'Host is not allowed.'
        return (New-FleetHttpResult -StatusCode 401 -Body (ConvertTo-FleetJson -Value $envelope) -ContentType 'application/json; charset=utf-8' -SetCookie $false)
    }
    $route = Resolve-FleetRoute -Path $Path
    $origin = [string]$headerMap['Origin']
    $expectedOrigin = 'http://127.0.0.1:' + $Port
    if ($route.Kind -eq 'id') {
        if ($methodName -ne 'GET') {
            $envelope = New-FleetFailure -Code 'E_ARGS' -Message 'Method is not allowed.'
            return (New-FleetHttpResult -StatusCode 400 -Body (ConvertTo-FleetJson -Value $envelope) -ContentType 'application/json; charset=utf-8' -SetCookie $false)
        }
        $identity = New-Object System.Management.Automation.PSObject
        $identity | Add-Member -MemberType NoteProperty -Name 'app' -Value $App
        $identity | Add-Member -MemberType NoteProperty -Name 'id' -Value $App
        $identity | Add-Member -MemberType NoteProperty -Name 'framework' -Value 'FleetAction'
        $identity | Add-Member -MemberType NoteProperty -Name 'frameworkVersion' -Value $script:FleetVersion
        $envelope = New-FleetSuccess -Result $identity
        return (New-FleetHttpResult -StatusCode 200 -Body (ConvertTo-FleetJson -Value $envelope) -ContentType 'application/json; charset=utf-8' -SetCookie $false)
    }
    if ($route.Kind -eq 'home') {
        if ($methodName -ne 'GET') {
            $envelope = New-FleetFailure -Code 'E_ARGS' -Message 'Method is not allowed.'
            return (New-FleetHttpResult -StatusCode 400 -Body (ConvertTo-FleetJson -Value $envelope) -ContentType 'application/json; charset=utf-8' -SetCookie $false)
        }
        if (-not [string]::IsNullOrEmpty($origin) -and ($origin -cne $expectedOrigin)) {
            $envelope = New-FleetFailure -Code 'E_AUTH' -Message 'Origin is not allowed.'
            return (New-FleetHttpResult -StatusCode 401 -Body (ConvertTo-FleetJson -Value $envelope) -ContentType 'application/json; charset=utf-8' -SetCookie $false)
        }
        $html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>FleetAction</title></head><body><p>FleetAction session started.</p></body></html>'
        return (New-FleetHttpResult -StatusCode 200 -Body $html -ContentType 'text/html; charset=utf-8' -SetCookie $true)
    }
    if (-not [string]::IsNullOrEmpty($Query) -or ($Path.IndexOf('?') -ge 0)) {
        # Query is checked after Host and Origin and the bearer token.
    }
    if ($origin -cne $expectedOrigin) {
        $envelope = New-FleetFailure -Code 'E_AUTH' -Message 'Origin is not allowed.'
        return (New-FleetHttpResult -StatusCode 401 -Body (ConvertTo-FleetJson -Value $envelope) -ContentType 'application/json; charset=utf-8' -SetCookie $false)
    }
    $presented = Get-FleetPresentedToken -HeaderMap $headerMap
    if (-not (Test-FleetTokenMatch -Presented $presented -Expected $Token)) {
        $envelope = New-FleetFailure -Code 'E_AUTH' -Message 'Bearer token is not valid.'
        return (New-FleetHttpResult -StatusCode 401 -Body (ConvertTo-FleetJson -Value $envelope) -ContentType 'application/json; charset=utf-8' -SetCookie $false)
    }
    if (-not [string]::IsNullOrEmpty($Query) -or ($Path.IndexOf('?') -ge 0)) {
        $envelope = New-FleetFailure -Code 'E_ARGS' -Message 'Query strings are not allowed.'
        return (New-FleetHttpResult -StatusCode 400 -Body (ConvertTo-FleetJson -Value $envelope) -ContentType 'application/json; charset=utf-8' -SetCookie $false)
    }
    if ($route.Kind -eq 'missing') {
        $envelope = New-FleetFailure -Code 'E_NOT_FOUND' -Message 'Route is not registered.'
        return (New-FleetHttpResult -StatusCode 404 -Body (ConvertTo-FleetJson -Value $envelope) -ContentType 'application/json; charset=utf-8' -SetCookie $false)
    }
    if ($route.Kind -eq 'actions') {
        if ($methodName -ne 'GET') {
            $envelope = New-FleetFailure -Code 'E_ARGS' -Message 'Method is not allowed.'
            return (New-FleetHttpResult -StatusCode 400 -Body (ConvertTo-FleetJson -Value $envelope) -ContentType 'application/json; charset=utf-8' -SetCookie $false)
        }
        $envelope = Get-FleetDiscoveryEnvelope -App $App
        return (New-FleetHttpResult -StatusCode 200 -Body (ConvertTo-FleetJson -Value $envelope) -ContentType 'application/json; charset=utf-8' -SetCookie $false)
    }
    $bodyText = ''
    if ($methodName -eq 'POST') {
        $read = Read-FleetLimitedBody -ContentLength $ContentLength -TransferEncoding $TransferEncoding -OpenBody $OpenBody
        if (-not $read.Ok) {
            $code = [string]$read.Code
            if ([string]::IsNullOrEmpty($code)) {
                $code = 'E_ARGS'
            }
            $envelope = New-FleetFailure -Code $code -Message ([string]$read.Message)
            return (New-FleetHttpResult -StatusCode (Get-FleetHttpStatus -Envelope $envelope) -Body (ConvertTo-FleetJson -Value $envelope) -ContentType 'application/json; charset=utf-8' -SetCookie $false)
        }
        $bodyText = [string]$read.Text
        if ([string]::IsNullOrEmpty($bodyText)) {
            $bodyText = '{}'
        }
    }
    elseif ($methodName -ne 'GET') {
        $envelope = New-FleetFailure -Code 'E_ARGS' -Message 'Method is not allowed.'
        return (New-FleetHttpResult -StatusCode 400 -Body (ConvertTo-FleetJson -Value $envelope) -ContentType 'application/json; charset=utf-8' -SetCookie $false)
    }
    $document = $null
    if ($methodName -eq 'POST') {
        try {
            $document = $bodyText | ConvertFrom-Json
        }
        catch {
            $envelope = New-FleetFailure -Code 'E_ARGS' -Message 'Request body is not valid JSON.'
            return (New-FleetHttpResult -StatusCode 400 -Body (ConvertTo-FleetJson -Value $envelope) -ContentType 'application/json; charset=utf-8' -SetCookie $false)
        }
        if (-not (Test-FleetJsonType -Value $document -TypeName 'object')) {
            $envelope = New-FleetFailure -Code 'E_ARGS' -Message 'Request body must be a JSON object.'
            return (New-FleetHttpResult -StatusCode 400 -Body (ConvertTo-FleetJson -Value $envelope) -ContentType 'application/json; charset=utf-8' -SetCookie $false)
        }
    }
    if ($route.Kind -eq 'job') {
        if ($methodName -ne 'POST') {
            $envelope = New-FleetFailure -Code 'E_ARGS' -Message 'Method is not allowed.'
            return (New-FleetHttpResult -StatusCode 400 -Body (ConvertTo-FleetJson -Value $envelope) -ContentType 'application/json; charset=utf-8' -SetCookie $false)
        }
        $envelope = Invoke-FleetJob -Job $document
        return (New-FleetHttpResult -StatusCode (Get-FleetHttpStatus -Envelope $envelope) -Body (ConvertTo-FleetJson -Value $envelope) -ContentType 'application/json; charset=utf-8' -SetCookie $false)
    }
    if ($route.Kind -eq 'action') {
        if ($methodName -ne 'POST') {
            $envelope = New-FleetFailure -Code 'E_ARGS' -Message 'Method is not allowed.'
            return (New-FleetHttpResult -StatusCode 400 -Body (ConvertTo-FleetJson -Value $envelope) -ContentType 'application/json; charset=utf-8' -SetCookie $false)
        }
        if ($route.App -cne $App) {
            $envelope = New-FleetFailure -Code 'E_NOT_FOUND' -Message 'Action is not registered.'
            return (New-FleetHttpResult -StatusCode 404 -Body (ConvertTo-FleetJson -Value $envelope) -ContentType 'application/json; charset=utf-8' -SetCookie $false)
        }
        foreach ($name in @(Get-FleetPropertyNames -Object $document)) {
            if ($name -cne 'args' -and $name -cne 'confirmed' -and $name -cne 'dryRun') {
                $envelope = New-FleetFailure -Code 'E_ARGS' -Message ('Unknown field ''' + $name + '''.')
                return (New-FleetHttpResult -StatusCode 400 -Body (ConvertTo-FleetJson -Value $envelope) -ContentType 'application/json; charset=utf-8' -SetCookie $false)
            }
        }
        $confirmed = $false
        $dryRun = $false
        if (Test-FleetHasProperty -Object $document -Name 'confirmed') {
            $flag = Get-FleetProperty -Object $document -Name 'confirmed'
            if ($flag -isnot [bool]) {
                $envelope = New-FleetFailure -Code 'E_ARGS' -Message 'confirmed must be a boolean.'
                return (New-FleetHttpResult -StatusCode 400 -Body (ConvertTo-FleetJson -Value $envelope) -ContentType 'application/json; charset=utf-8' -SetCookie $false)
            }
            $confirmed = [bool]$flag
        }
        if (Test-FleetHasProperty -Object $document -Name 'dryRun') {
            $flag = Get-FleetProperty -Object $document -Name 'dryRun'
            if ($flag -isnot [bool]) {
                $envelope = New-FleetFailure -Code 'E_ARGS' -Message 'dryRun must be a boolean.'
                return (New-FleetHttpResult -StatusCode 400 -Body (ConvertTo-FleetJson -Value $envelope) -ContentType 'application/json; charset=utf-8' -SetCookie $false)
            }
            $dryRun = [bool]$flag
        }
        $argsObject = $null
        if (Test-FleetHasProperty -Object $document -Name 'args') {
            $argsObject = Get-FleetProperty -Object $document -Name 'args'
        }
        $envelope = Invoke-FleetAction -App $route.App -Noun $route.Noun -Verb $route.Verb -Arguments $argsObject -Confirmed:$confirmed -DryRun:$dryRun
        return (New-FleetHttpResult -StatusCode (Get-FleetHttpStatus -Envelope $envelope) -Body (ConvertTo-FleetJson -Value $envelope) -ContentType 'application/json; charset=utf-8' -SetCookie $false)
    }
    $envelope = New-FleetFailure -Code 'E_NOT_FOUND' -Message 'Route is not registered.'
    return (New-FleetHttpResult -StatusCode 404 -Body (ConvertTo-FleetJson -Value $envelope) -ContentType 'application/json; charset=utf-8' -SetCookie $false)
}

function Read-FleetRequestStream {
    param($Request, [int]$MaxBytes)
    $toRead = $MaxBytes
    if ($Request.ContentLength64 -ge 0 -and $Request.ContentLength64 -lt $toRead) {
        $toRead = [int]$Request.ContentLength64
    }
    if ($toRead -lt 0) {
        $toRead = 0
    }
    $buffer = New-Object byte[] $toRead
    $offset = 0
    $stream = $Request.InputStream
    while ($offset -lt $toRead) {
        $count = $stream.Read($buffer, $offset, $toRead - $offset)
        if ($count -le 0) {
            break
        }
        $offset += $count
    }
    return [System.Text.Encoding]::UTF8.GetString($buffer, 0, $offset)
}

function Write-FleetHttpResponse {
    param(
        $Response,
        [int]$StatusCode,
        [string]$Body,
        [string]$ContentType,
        [bool]$SetCookie,
        [string]$Token
    )
    $Response.StatusCode = $StatusCode
    $Response.ContentType = $ContentType
    $Response.Headers['Cache-Control'] = 'no-store'
    if ($SetCookie -and -not [string]::IsNullOrEmpty($Token)) {
        $cookie = 'FleetSession=' + $Token + '; HttpOnly; SameSite=Strict; Path=/'
        $Response.Headers.Add('Set-Cookie', $cookie)
    }
    $utf8 = New-Object System.Text.UTF8Encoding $false
    $bytes = $utf8.GetBytes($Body)
    $Response.ContentLength64 = $bytes.Length
    $Response.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Test-FleetPortOpen {
    param([int]$Port)
    $client = $null
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        $ok = $async.AsyncWaitHandle.WaitOne(200)
        if (-not $ok) {
            return $false
        }
        $client.EndConnect($async)
        return $true
    }
    catch {
        return $false
    }
    finally {
        if ($null -ne $client) {
            $client.Close()
        }
    }
}

function Get-FleetFreePort {
    $listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback), 0
    $listener.Start()
    $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    $listener.Stop()
    return $port
}

function Start-FleetServer {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$App,
        [int]$Port = 0
    )
    $appName = $App.ToLowerInvariant()
    if ($appName -notmatch $script:FleetNamePattern) {
        throw 'App name is invalid.'
    }
    if ($Port -eq 0) {
        $Port = Get-FleetFreePort
    }
    if ($Port -lt 1 -or $Port -gt 65535) {
        throw 'Port is out of range.'
    }
    $root = Get-FleetAppRoot -App $appName
    if (-not (Test-Path -LiteralPath $root)) {
        New-Item -ItemType Directory -Path $root -Force | Out-Null
    }
    $stopPath = Join-Path -Path $root -ChildPath 'server.stop'
    $tokenPath = Join-Path -Path $root -ChildPath 'session.token'
    $portPath = Join-Path -Path $root -ChildPath 'session.port'
    if (Test-Path -LiteralPath $stopPath) {
        Remove-Item -LiteralPath $stopPath -Force
    }
    $token = New-FleetSessionToken
    New-FleetTokenPlaceholder -Path $tokenPath
    Write-FleetTokenFile -Path $tokenPath -Token $token
    $prefix = 'http://127.0.0.1:' + $Port.ToString() + '/'
    if ($prefix -notmatch '^http://127\.0\.0\.1:[0-9]+/$') {
        throw 'Refusing to bind a non-loopback prefix.'
    }
    $listener = New-Object System.Net.HttpListener
    $listener.Prefixes.Add($prefix)
    try {
        $listener.IgnoreWriteExceptions = $true
    }
    catch {
        Write-FleetLog -Message 'listener write exceptions remain enabled'
    }
    try {
        $listener.Start()
    }
    catch {
        Remove-Item -LiteralPath $tokenPath -Force -ErrorAction SilentlyContinue
        throw
    }
    [System.IO.File]::WriteAllText($portPath, $Port.ToString())
    Write-FleetLog -Message ('listen ' + $prefix)
    try {
        while ($true) {
            if (Test-Path -LiteralPath $stopPath) {
                break
            }
            $async = $listener.BeginGetContext($null, $null)
            $signaled = $async.AsyncWaitHandle.WaitOne(400)
            if (-not $signaled) {
                continue
            }
            if (Test-Path -LiteralPath $stopPath) {
                break
            }
            $context = $null
            try {
                $context = $listener.EndGetContext($async)
            }
            catch {
                # A client that connects and then goes away must not stop the listener.
                continue
            }
            $response = $context.Response
            $wrote = $false
            try {
                $request = $context.Request
                $headerMap = @{}
                foreach ($headerName in @($request.Headers.AllKeys)) {
                    $headerMap[$headerName] = [string]$request.Headers[$headerName]
                }
                $script:FleetCurrentRequest = $request
                $openBody = {
                    param($MaxBytes)
                    return (Read-FleetRequestStream -Request $script:FleetCurrentRequest -MaxBytes $MaxBytes)
                }
                $transfer = ''
                if (Test-FleetHasProperty -Object $headerMap -Name 'Transfer-Encoding') {
                    $transfer = [string]$headerMap['Transfer-Encoding']
                }
                elseif ($null -ne $headerMap['Transfer-Encoding']) {
                    $transfer = [string]$headerMap['Transfer-Encoding']
                }
                $result = Invoke-FleetHttpPipeline -App $appName -Port $Port -Token $token -Method $request.HttpMethod -Path $request.Url.AbsolutePath -Query ([string]$request.Url.Query) -Headers $headerMap -ContentLength $request.ContentLength64 -TransferEncoding $transfer -OpenBody $openBody
                Write-FleetHttpResponse -Response $response -StatusCode $result.StatusCode -Body $result.Body -ContentType $result.ContentType -SetCookie $result.SetCookie -Token $token
                $wrote = $true
            }
            catch {
                if (-not $wrote) {
                    try {
                        $fallback = ConvertTo-FleetJson -Value (New-FleetFailure -Code 'E_INTERNAL' -Message $script:FleetInternalMessage)
                        Write-FleetHttpResponse -Response $response -StatusCode 500 -Body $fallback -ContentType 'application/json; charset=utf-8' -SetCookie $false -Token ''
                    }
                    catch {
                        Write-FleetLog -Message 'response could not be written'
                    }
                }
            }
            finally {
                try {
                    $response.Close()
                }
                catch {
                    Write-FleetLog -Message 'response close failed'
                }
            }
        }
    }
    finally {
        try {
            $listener.Stop()
        }
        catch {
            Write-FleetLog -Message 'listener stop failed'
        }
        try {
            $listener.Close()
        }
        catch {
            Write-FleetLog -Message 'listener close failed'
        }
        Remove-Item -LiteralPath $tokenPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $portPath -Force -ErrorAction SilentlyContinue
    }
}

function Stop-FleetServer {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$App,
        [int]$TimeoutSeconds = 20
    )
    $root = Get-FleetAppRoot -App $App
    if (-not (Test-Path -LiteralPath $root)) {
        return
    }
    $stopPath = Join-Path -Path $root -ChildPath 'server.stop'
    $tokenPath = Join-Path -Path $root -ChildPath 'session.token'
    $portPath = Join-Path -Path $root -ChildPath 'session.port'
    $running = $false
    if (Test-Path -LiteralPath $portPath) {
        $portText = ([System.IO.File]::ReadAllText($portPath)).Trim()
        $portNumber = 0
        if ([int]::TryParse($portText, [ref]$portNumber)) {
            $running = Test-FleetPortOpen -Port $portNumber
        }
    }
    if (-not $running) {
        Remove-Item -LiteralPath $tokenPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $portPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $stopPath -Force -ErrorAction SilentlyContinue
        return
    }
    [System.IO.File]::WriteAllText($stopPath, 'stop')
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (-not (Test-Path -LiteralPath $tokenPath)) {
            Remove-Item -LiteralPath $stopPath -Force -ErrorAction SilentlyContinue
            return
        }
        Start-Sleep -Milliseconds 100
    }
    Remove-Item -LiteralPath $tokenPath -Force -ErrorAction SilentlyContinue
    throw 'Server did not stop before the timeout.'
}

function New-FleetGapResult {
    param($Gaps)
    $items = New-Object System.Collections.Generic.List[string]
    foreach ($gap in @($Gaps)) {
        if ($null -ne $gap -and -not [string]::IsNullOrEmpty([string]$gap)) {
            $items.Add([string]$gap)
        }
    }
    $result = New-Object System.Management.Automation.PSObject
    $result | Add-Member -MemberType NoteProperty -Name 'Gaps' -Value ($items.ToArray())
    return $result
}

function Add-FleetDataActionGaps {
    param($Html, $Js, $Gaps)
    $index = 0
    while ($true) {
        $foundAt = $Html.IndexOf('data-action', $index)
        if ($foundAt -lt 0) {
            break
        }
        $start = $Html.LastIndexOf('<', $foundAt)
        if ($start -lt 0) {
            $Gaps.Add('data-action is not on a native element')
        }
        else {
            $length = $Html.Length - $start
            if ($length -gt 80) {
                $length = 80
            }
            $slice = $Html.Substring($start, $length)
            if ($slice -match '^<\s*/?\s*([A-Za-z0-9]+)') {
                $tag = $Matches[1].ToLowerInvariant()
                if ($tag -ne 'button' -and $tag -ne 'a') {
                    $Gaps.Add('data-action is on <' + $tag + '>')
                }
            }
            else {
                $Gaps.Add('data-action is not on a native element')
            }
        }
        $index = $foundAt + 11
    }
    $reduced = $Js
    $reduced = $reduced.Replace('[data-action]', '')
    $reduced = $reduced.Replace("getAttribute('data-action')", '')
    $reduced = $reduced.Replace('getAttribute("data-action")', '')
    if ($reduced.IndexOf('data-action') -ge 0) {
        $Gaps.Add('data-action in script is not a query or getAttribute')
    }
}

function Test-FleetGuiParity {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)
    $gaps = New-Object System.Collections.Generic.List[string]
    if (-not (Test-Path -LiteralPath $Path)) {
        $gaps.Add('GUI path was not found.')
        return (New-FleetGapResult -Gaps $gaps)
    }
    $files = @()
    $item = Get-Item -LiteralPath $Path
    if ($item.PSIsContainer) {
        $files = @(Get-ChildItem -LiteralPath $Path -Recurse -File | Where-Object {
                $_.Extension -eq '.html' -or $_.Extension -eq '.css' -or $_.Extension -eq '.js'
            })
    }
    else {
        $files = @($item)
    }
    if ($files.Count -eq 0) {
        $gaps.Add('GUI path has no html, css, or js files.')
        return (New-FleetGapResult -Gaps $gaps)
    }
    $html = ''
    $js = ''
    $css = ''
    $all = ''
    foreach ($file in $files) {
        $text = [System.IO.File]::ReadAllText($file.FullName)
        $all = $all + $text
        $extension = $file.Extension.ToLowerInvariant()
        if ($extension -eq '.html') {
            $html = $html + $text
        }
        elseif ($extension -eq '.js') {
            $js = $js + $text
        }
        elseif ($extension -eq '.css') {
            $css = $css + $text
        }
    }
    Add-FleetDataActionGaps -Html $html -Js $js -Gaps $gaps
    $lower = $all.ToLowerInvariant()
    if ($lower.IndexOf('aria-busy') -lt 0) {
        $gaps.Add('missing aria-busy')
    }
    if ($lower.IndexOf('aria-disabled') -lt 0) {
        $gaps.Add('missing aria-disabled')
    }
    $htmlLower = $html.ToLowerInvariant()
    $statusOk = ($htmlLower.IndexOf('role="status"') -ge 0) -or ($htmlLower.IndexOf("role='status'") -ge 0) -or ($lower.IndexOf('aria-live="polite"') -ge 0) -or ($lower.IndexOf("aria-live='polite'") -ge 0)
    if (-not $statusOk) {
        $gaps.Add('missing status announcement')
    }
    $alertOk = ($htmlLower.IndexOf('role="alert"') -ge 0) -or ($htmlLower.IndexOf("role='alert'") -ge 0) -or ($lower.IndexOf('aria-live="assertive"') -ge 0) -or ($lower.IndexOf("aria-live='assertive'") -ge 0)
    if (-not $alertOk) {
        $gaps.Add('missing alert announcement')
    }
    if ($htmlLower.IndexOf('<dialog') -lt 0) {
        $gaps.Add('missing native confirm dialog')
    }
    if (-not [regex]::IsMatch($html, '<button\b[^>]*\bautofocus\b[^>]*>\s*Cancel\s*</button>', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
        $gaps.Add('Cancel is not the default')
    }
    if ([regex]::IsMatch($all, '(?i)(^|[^\w.])confirm\s*\(')) {
        $gaps.Add('confirm() is not allowed')
    }
    if ($all.IndexOf('error.message') -lt 0) {
        $gaps.Add('errors must use error.message')
    }
    foreach ($banned in @('session.token', 'bearer', 'authorization', 'fleetsession', 'document.cookie')) {
        if ($lower.IndexOf($banned) -ge 0) {
            $gaps.Add('token appears in the GUI source')
            break
        }
    }
    $sizeText = ($css + $html).Replace(' ', '').Replace("`t", '')
    if ($sizeText.IndexOf('min-height:32px') -lt 0 -or $sizeText.IndexOf('min-width:32px') -lt 0) {
        $gaps.Add('targets must be at least 32px')
    }
    return (New-FleetGapResult -Gaps $gaps)
}

Export-ModuleMember -Function @(
    'Register-FleetAction',
    'Clear-FleetAction',
    'Get-FleetAction',
    'Invoke-FleetAction',
    'Invoke-FleetCli',
    'Invoke-FleetJob',
    'Start-FleetServer',
    'Stop-FleetServer',
    'Read-FleetSessionToken',
    'Test-FleetDocument',
    'Test-FleetGuiParity',
    'New-FleetErrorRecord',
    'Get-FleetContractFile'
)
