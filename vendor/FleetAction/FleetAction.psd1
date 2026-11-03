@{
    RootModule        = 'FleetAction.psm1'
    ModuleVersion     = '1.0.0'
    GUID              = 'dd7c41ff-c702-4ae6-a4a8-b4e7080d0510'
    Author            = 'FleetHacker'
    CompanyName       = 'Data Crucible Team for Fleethacker'
    Copyright         = '(c) 2026 Data Crucible Team for Fleethacker'
    Description       = 'Fleet CLI/API action framework. JSON jobs, noun-verb actions, localhost API.'
    PowerShellVersion = '5.1'
    FunctionsToExport = @(
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
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
    PrivateData       = @{
        PSData = @{
            Tags       = @('FleetHacker', 'FleetAction', 'CLI')
            LicenseUri = 'https://github.com/fleethacker-data-crucible/fleet-action-baseline/blob/main/LICENSE'
            ProjectUri = 'https://github.com/fleethacker-data-crucible/fleet-action-baseline'
        }
    }
}
