$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

if (!(Test-Path '.env')) {
    throw 'Missing .env. Copy .env.example to .env and configure DATABASE_URL first.'
}

if (!(Test-Path 'node_modules')) {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}

npm run db:migrate
if ($LASTEXITCODE -ne 0) { throw 'Database migration failed. Check DATABASE_URL and PostgreSQL availability.' }

Write-Output 'Operator dashboard: http://127.0.0.1:3000/operator/'
npm start
if ($LASTEXITCODE -ne 0) { throw 'Dashboard server stopped with an error.' }
