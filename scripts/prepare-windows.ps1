param([switch]$DebugWorker)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Set-Location (Join-Path $PSScriptRoot '..')
$revision = 'a8d002cfd879315632a579e73f0148d06959de36' # whisper.cpp v1.7.6
$source = Join-Path (Get-Location) '.cache/whisper-src'
$build = Join-Path (Get-Location) '.cache/whisper-build'
$destination = Join-Path (Get-Location) 'src-tauri/binaries'
New-Item -ItemType Directory -Force -Path '.cache', $destination | Out-Null
function Check-Native { if ($LASTEXITCODE -ne 0) { throw "Command failed with exit code $LASTEXITCODE" } }
if (-not (Test-Path $source)) {
  New-Item -ItemType Directory -Path $source | Out-Null
  git -C $source init --quiet; Check-Native
  git -C $source fetch --quiet --depth 1 https://github.com/ggml-org/whisper.cpp.git $revision; Check-Native
  git -C $source checkout --quiet --detach FETCH_HEAD; Check-Native
}
$actual = (git -C $source rev-parse HEAD).Trim(); Check-Native
if ($actual -ne $revision) { throw 'Unexpected whisper-src revision. Preserve or move that cache before retrying.' }
cmake -S $source -B $build "-DCMAKE_PROJECT_TOP_LEVEL_INCLUDES=$PSScriptRoot/portable-whisper.cmake" -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON
Check-Native
cmake --build $build --config Release --target quantize --parallel 2
Check-Native
$quantizer = Get-ChildItem $build -Recurse -Filter quantize.exe | Select-Object -First 1
if (-not $quantizer) { throw 'quantize.exe was not produced' }
Copy-Item $quantizer.FullName (Join-Path $destination 'whisper-quantize.exe')
node scripts/generate-icons.mjs
Check-Native
$profile = if ($DebugWorker) { 'debug' } else { 'release' }
$cargoArguments = @('build', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--features', 'asr', '--bin', 'lyrics-whisper')
if (-not $DebugWorker) { $cargoArguments += '--release' }
cargo @cargoArguments
Check-Native
Copy-Item "src-tauri/target/$profile/lyrics-whisper.exe" (Join-Path $destination 'lyrics-whisper.exe')
Write-Host 'Whisper worker and verified-source quantizer are ready in src-tauri/binaries.'
