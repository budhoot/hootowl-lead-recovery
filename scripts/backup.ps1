$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$backupDir = Join-Path (Get-Location) 'local\backups'
New-Item -ItemType Directory -Force $backupDir | Out-Null
$backupName = 'hootowl-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.dump'
docker exec hootowl-postgres pg_dump -U hootowl -d hootowl_lead_recovery -Fc -f /tmp/hootowl-backup.dump
if ($LASTEXITCODE -ne 0) { throw 'Database backup failed.' }
docker cp hootowl-postgres:/tmp/hootowl-backup.dump (Join-Path $backupDir $backupName)
if ($LASTEXITCODE -ne 0) { throw 'Backup copy failed.' }
Write-Output "Backup saved to local\backups\$backupName. Copy it to your protected off-device backup location."
