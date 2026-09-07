param(
    [string]$BinDirectory = (Join-Path $env:LOCALAPPDATA 'Sawhorse\bin'),
    [switch]$NoPathUpdate
)
$ErrorActionPreference = 'Stop'
$sawhorseSource = Join-Path $PSScriptRoot 'sawhorse.exe'
New-Item -ItemType Directory -Path $BinDirectory -Force | Out-Null
$sawhorseTarget = Join-Path $BinDirectory 'sawhorse.exe'
Copy-Item -LiteralPath $sawhorseSource -Destination $sawhorseTarget -Force
if (-not $NoPathUpdate) {
    $sawhorseUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $sawhorseEntries = @($sawhorseUserPath -split ';' | Where-Object { $_ })
    if (-not ($sawhorseEntries | Where-Object { $_.TrimEnd('\') -ieq $BinDirectory.TrimEnd('\') })) {
        [Environment]::SetEnvironmentVariable('Path', (($sawhorseEntries + $BinDirectory) -join ';'), 'User')
    }
    if (-not (($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -ieq $BinDirectory.TrimEnd('\') })) {
        $env:Path = $env:Path + ';' + $BinDirectory
    }
}
& $sawhorseTarget --version
if ($LASTEXITCODE -ne 0) { throw 'Installed CLI did not run successfully.' }
Write-Output "Installed: $sawhorseTarget"
