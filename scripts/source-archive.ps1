$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$archivePath = Join-Path $projectRoot 'dist\SendIt-Source.zip'
New-Item -ItemType Directory -Path (Join-Path $projectRoot 'dist') -Force | Out-Null
$sourceEntries = @(
  'src', 'tests', 'docs', 'assets', 'scripts',
  'package.json', 'package-lock.json', 'electron-builder.yml',
  'tsconfig.json', 'vite.config.ts', 'vitest.config.ts', 'index.html',
  'README.md', 'LICENSE', '.gitignore', '.prettierrc.json', '.prettierignore'
)
Push-Location $projectRoot
try {
  # Windows 10/11 bsdtar creates ZIP with -a. Explicit entries exclude local data,
  # dependencies, release artifacts and the reference-only Postman screenshot.
  & tar.exe -a -cf $archivePath @sourceEntries
  if ($LASTEXITCODE -ne 0) { throw 'Source archive creation failed.' }
  $archiveItems = & tar.exe -tf $archivePath
  if ($LASTEXITCODE -ne 0) { throw 'Source archive verification failed.' }
  if ($archiveItems | Where-Object { $_ -match '^(node_modules|research|dist|\.test-data|SendIt-data)/' }) {
    throw 'Unexpected private or generated content in source archive.'
  }
  if ($archiveItems -notcontains 'src/main/index.ts') { throw 'Source archive is incomplete.' }
  Get-Item -LiteralPath $archivePath | Select-Object FullName, Length
  Get-FileHash -LiteralPath $archivePath -Algorithm SHA256
} finally {
  Pop-Location
}
