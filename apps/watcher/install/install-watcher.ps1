# Delta Desk watcher: install or update it on this PC. install.cmd runs this (double-click it).
# Copies watcher.exe to C:\Traders, writes watcher.json (server, token, ODIN's OnLineBackup folder),
# starts it at every logon (a shortcut in this user's Startup folder, no admin needed) and starts it now.
# Run again to update: Enter keeps the installed token and folder.
$ErrorActionPreference = 'Stop'
$Server = 'https://delta.optionbhai.com'
$Dir = 'C:\Traders'
$Include = @('*/Trades/*TRD.TXT', '*/Orders/*.txt', '*/Orders/*.TXT')
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $Dir 'watcher.exe'
$CfgPath = Join-Path $Dir 'watcher.json'
$LogPath = Join-Path $Dir 'watcher.log'

function Fail([string]$msg) { Write-Host ''; Write-Host $msg -ForegroundColor Red; exit 1 }

Write-Host 'Delta Desk watcher setup' -ForegroundColor Cyan
if (-not (Test-Path (Join-Path $Here 'watcher.exe'))) { Fail 'watcher.exe is not next to this script. Extract the whole zip first, then run install.cmd from that folder.' }

$old = $null
if (Test-Path $CfgPath) { try { $old = Get-Content $CfgPath -Raw | ConvertFrom-Json } catch { $old = $null } }

# The token: issued on the Delta Desk Admin tab, shown once.
$ask = 'Paste the token from the Delta Desk Admin tab'
if ($old -and $old.token) { $ask += ' (Enter keeps the installed one)' }
$token = (Read-Host $ask).Trim()
if ($token -eq '' -and $old -and $old.token) { $token = [string]$old.token }
if ($token.Length -lt 20) { Fail 'That token is too short (a token is at least 20 characters). Issue one on the Admin tab and run install.cmd again.' }

# ODIN's OnLineBackup folder (the one holding Trades and Orders): the installed one, else looked for where ODIN usually sits.
$guess = $null
if ($old -and $old.folder -and (Test-Path ([string]$old.folder))) { $guess = [string]$old.folder }
if (-not $guess) {
  Write-Host 'Looking for ODIN''s OnLineBackup folder...'
  $roots = @('C:\', $env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ }
  $found = @(@(foreach ($r in $roots) {
    Get-ChildItem -Path $r -Directory -Filter '*ODIN*' -ErrorAction SilentlyContinue | ForEach-Object {
      Get-ChildItem -Path $_.FullName -Directory -Filter 'OnLineBackup' -Recurse -Depth 3 -ErrorAction SilentlyContinue
    }
  }) | Select-Object -ExpandProperty FullName -Unique)
  if ($found.Count -eq 1) { $guess = $found[0] }
  elseif ($found.Count -gt 1) {
    for ($i = 0; $i -lt $found.Count; $i++) { Write-Host ("  {0}) {1}" -f ($i + 1), $found[$i]) }
    $pick = (Read-Host 'Which one is this trader''s? Enter its number').Trim()
    if ($pick -match '^\d+$' -and [int]$pick -ge 1 -and [int]$pick -le $found.Count) { $guess = $found[[int]$pick - 1] }
  }
}
$ask = 'ODIN OnLineBackup folder'
if ($guess) { $ask += " (Enter for $guess)" }
$folder = (Read-Host $ask).Trim().Trim('"')
if ($folder -eq '') { $folder = $guess }
if (-not $folder -or -not (Test-Path $folder -PathType Container)) { Fail "No such folder: '$folder'. Find OnLineBackup inside the ODIN install (it holds Trades and Orders) and run install.cmd again." }

# Stop the running copy, put the new one in place.
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
Get-Process -Name watcher -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Exe } | Stop-Process -Force
Start-Sleep -Milliseconds 800
Copy-Item (Join-Path $Here 'watcher.exe') $Exe -Force
Unblock-File $Exe

# watcher.json as UTF-8 without a BOM (the watcher's JSON reader refuses one), readable by this user only: it holds the token.
$json = [ordered]@{ server = $Server; token = $token; folder = $folder; include = $Include } | ConvertTo-Json
[IO.File]::WriteAllText($CfgPath, $json, (New-Object Text.UTF8Encoding $false))
& icacls $CfgPath /inheritance:r /grant:r "$($env:USERDOMAIN)\$($env:USERNAME):F" 'SYSTEM:F' | Out-Null

# At every logon: a Startup shortcut. An older scheduled task from the manual steps is removed so it does not run twice.
cmd /c 'schtasks /Query /TN "Traders Watcher" >nul 2>&1'
if ($LASTEXITCODE -eq 0) { cmd /c 'schtasks /End /TN "Traders Watcher" >nul 2>&1 & schtasks /Delete /TN "Traders Watcher" /F >nul 2>&1' }
$lnk = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) 'Delta Desk watcher.lnk'))
$lnk.TargetPath = $Exe
$lnk.WorkingDirectory = $Dir
$lnk.Save()

Start-Process -FilePath $Exe -WorkingDirectory $Dir
Write-Host ''
Write-Host "Installed in $Dir and started; it starts again at every logon." -ForegroundColor Green
Write-Host "Watching: $folder"
Start-Sleep -Seconds 6
if (Test-Path $LogPath) { Write-Host ''; Write-Host 'watcher.log:'; Get-Content $LogPath -Tail 6 }
Write-Host ''
Write-Host 'Within a minute the trader''s heartbeat shows on the Delta Desk Admin tab.'
