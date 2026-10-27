param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Set-Location (Join-Path $PSScriptRoot '..')
$root = (Get-Location).Path
$version = (Get-Content 'package.json' -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Unexpected package version' }
if ($env:GITHUB_REF -like 'refs/tags/*' -and $env:GITHUB_REF -ne "refs/tags/v$version") {
  throw 'Release tag must match package.json version'
}
$installers = @(Get-ChildItem 'src-tauri/target/release/bundle/nsis' -Filter '*.exe' -File)
if ($installers.Count -ne 1) { throw 'Expected exactly one built NSIS installer' }
if (-not (Test-Path 'dist/extension/manifest.json')) { throw 'Build the extension after the frontend first' }
$output = Join-Path $root 'dist/packages'
New-Item -ItemType Directory -Force -Path $output | Out-Null
$staging = Join-Path ([System.IO.Path]::GetTempPath()) ('still-package-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging | Out-Null
try {
  Copy-Item $installers[0].FullName (Join-Path $staging "Still-Setup-$version-x64.exe")
  Copy-Item 'dist/extension' (Join-Path $staging 'extension') -Recurse
  Copy-Item 'docs/windows-install.md' (Join-Path $staging 'INSTALL-RU.md')
  $contents = Get-ChildItem $staging -Recurse -File | Sort-Object FullName | ForEach-Object {
    $relative = [System.IO.Path]::GetRelativePath($staging, $_.FullName).Replace('\', '/')
    '{0}  {1}' -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $relative
  }
  $contents | Set-Content (Join-Path $staging 'CONTENTS-SHA256.txt') -Encoding utf8
  $application = Join-Path $output "Still-v$version-Windows-x64.zip"
  $extension = Join-Path $output "Still-v$version-Chrome-Edge-extension.zip"
  Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $application -Force
  Compress-Archive -Path 'dist/extension/*' -DestinationPath $extension -Force
  @($application, $extension) | ForEach-Object {
    '{0}  {1}' -f (Get-FileHash $_ -Algorithm SHA256).Hash.ToLowerInvariant(), [System.IO.Path]::GetFileName($_)
  } | Set-Content (Join-Path $output 'SHA256SUMS.txt') -Encoding utf8
  Write-Host "Download packages and SHA-256 checksums are ready in $output"
} finally {
  # This is a newly allocated staging directory containing only our copies.
  Remove-Item -LiteralPath $staging -Recurse -Force
}
