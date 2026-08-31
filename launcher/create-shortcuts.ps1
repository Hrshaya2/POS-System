# Creates desktop shortcuts for the POS launcher:
#   "POS System"        -> StartPOS.exe start
#   "Stop POS System"   -> StartPOS.exe stop
$exe = Join-Path $PSScriptRoot 'StartPOS.exe'
if (-not (Test-Path $exe)) { throw "StartPOS.exe not found at $exe - compile it first." }

$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')

$s = $ws.CreateShortcut((Join-Path $desktop 'POS System.lnk'))
$s.TargetPath = $exe
$s.Arguments = 'start'
$s.WorkingDirectory = Split-Path $PSScriptRoot
$s.IconLocation = "$exe,0"
$s.Description = 'Start the Nangi POS system'
$s.Save()

$s2 = $ws.CreateShortcut((Join-Path $desktop 'Stop POS System.lnk'))
$s2.TargetPath = $exe
$s2.Arguments = 'stop'
$s2.WorkingDirectory = Split-Path $PSScriptRoot
$s2.IconLocation = "$exe,0"
$s2.Description = 'Stop the Nangi POS servers'
$s2.Save()

Write-Output ("desktop: {0}" -f $desktop)
Get-ChildItem $desktop -Filter 'POS*.lnk' | ForEach-Object { Write-Output ("created: {0}" -f $_.FullName) }
