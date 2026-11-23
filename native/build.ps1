# Build native/atvv-capture.exe without the DSH host.
#
# Use this when endpoint protection blocks the plugin's first-run compile, or
# when you want to verify a change to the C# helper by hand. The plugin prefers
# a prebuilt native/atvv-capture.exe over compiling, so a successful build here
# means the host never invokes csc.exe at runtime.
#
# Usage:
#   pwsh -File native/build.ps1
#   pwsh -File native/build.ps1 -Output C:\path\to\atvv-capture.exe
#
# Requirements: .NET Framework 4.x (csc.exe ships with Windows) and the Windows
# SDK's merged WinRT metadata (Windows Kits\10\UnionMetadata\<ver>\Windows.winmd).
param(
    [string]$Output = (Join-Path $PSScriptRoot 'atvv-capture.exe')
)

$ErrorActionPreference = 'Stop'

function Find-Csc {
    $candidates = @(
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { return $candidate }
    }
    throw 'csc.exe not found: install .NET Framework 4.x (it ships with Windows).'
}

function Find-Winmd {
    $roots = @()
    if ($env:WindowsSdkDir) { $roots += Join-Path $env:WindowsSdkDir 'UnionMetadata' }
    if (${env:ProgramFiles(x86)}) { $roots += Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\UnionMetadata' }
    if ($env:ProgramFiles) { $roots += Join-Path $env:ProgramFiles 'Windows Kits\10\UnionMetadata' }
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        $merged = Join-Path $root 'Windows.winmd'
        if (Test-Path $merged) { return $merged }
        # Newest SDK version first. Skip "Facade": its Windows.winmd carries only
        # type forwarders and compiles to CS1070 "type not found" errors.
        $versions = Get-ChildItem $root -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
            Sort-Object Name -Descending
        foreach ($version in $versions) {
            $candidate = Join-Path $version.FullName 'Windows.winmd'
            if (Test-Path $candidate) { return $candidate }
        }
    }
    throw 'Windows.winmd not found: install the Windows SDK (Windows Kits\10\UnionMetadata).'
}

$csc = Find-Csc
$winmd = Find-Winmd
$framework = Split-Path $csc -Parent
$source = Join-Path $PSScriptRoot 'atvv-capture.cs'
if (-not (Test-Path $source)) { throw "source not found: $source" }
$refs = @(
    "/r:$winmd",
    "/r:$(Join-Path $framework 'System.Runtime.dll')",
    "/r:$(Join-Path $framework 'System.Runtime.InteropServices.WindowsRuntime.dll')",
    "/r:$(Join-Path $framework 'System.Runtime.WindowsRuntime.dll')"
)

Write-Host "csc:    $csc"
Write-Host "winmd:  $winmd"
Write-Host "output: $Output"

& $csc /nologo /target:exe /codepage:65001 "/out:$Output" $refs $source
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }

Write-Host "built:  $((Get-Item $Output).Length) bytes"
