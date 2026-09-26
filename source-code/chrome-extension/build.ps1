# Packages the HProxy extension into a Chrome Web Store-ready zip.
#
#   Usage:  pwsh ./build.ps1      (run from inside the hproxy-extension folder)
#   Output: dist/hproxy-extension-v<version>.zip, with manifest.json at the
#           zip root (Chrome requires the manifest at the archive root).
#
# Only runtime assets are shipped. The README, this script, tests/,
# dist/, VCS files and Chrome's generated _metadata/ are left out.

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# Regenerate the design tokens from the website FIRST, then verify nothing in
# the stylesheets went off-system. A zip must never be buildable with a stale
# palette: that is exactly how the popup shipped three WCAG-failing status
# colours for two days in July. See scripts/sync-tokens.mjs.
node scripts/sync-tokens.mjs
if ($LASTEXITCODE -ne 0) { throw 'Token sync failed. Fix it before packaging.' }
node scripts/verify-design.mjs
if ($LASTEXITCODE -ne 0) { throw 'Design verification failed. Fix it before packaging.' }

# The parser and the analyzer's grading are tested; a zip is never built red.
node --test (Get-ChildItem tests -Filter *.test.mjs | ForEach-Object { $_.FullName })
if ($LASTEXITCODE -ne 0) { throw 'Tests failed. Fix them before packaging.' }

# The popup shows flags/*.png, drawn from flags/*.svg. A zip with a missing or
# stale PNG would show a broken image in the country list.
node scripts/rasterize-flags.mjs --check
if ($LASTEXITCODE -ne 0) { throw 'Flag PNGs are stale. Run: node scripts/rasterize-flags.mjs' }

$manifest = Get-Content -Raw manifest.json | ConvertFrom-Json
$version  = $manifest.version
$dist     = Join-Path $PSScriptRoot 'dist'
$stage    = Join-Path $dist 'stage'
$zip      = Join-Path $dist "hproxy-extension-v$version.zip"

# One popup (popup.html, the desktop app's look since 1.0). The three design
# review versions and their switcher are gone, as a live version picker is a
# development affordance, not a feature.
$include = @(
  'manifest.json', 'background.js', 'tokens.css', 'popup.css', 'popup.js', 'analyzer.js', 'line.js',
  'popup.html',
  'icons', 'fonts', 'flags/LICENSE'
)

$missing = $include | Where-Object { -not (Test-Path $_) }
if ($missing) { throw "Missing required asset(s): $($missing -join ', ')" }

# Stage the files, so the manifest inside the zip can differ from the one used
# for loading the folder unpacked.
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null
foreach ($item in $include | Where-Object { $_ -notlike 'flags/*' }) { Copy-Item $item -Destination $stage -Recurse }

# Flags: the PNGs the popup shows and flag-icons' licence. The SVGs are the
# source the PNGs are drawn from (scripts/rasterize-flags.mjs), not shipped.
$stageFlags = Join-Path $stage 'flags'
New-Item -ItemType Directory -Force -Path $stageFlags | Out-Null
Copy-Item 'flags/*.png', 'flags/LICENSE' -Destination $stageFlags

# The `key` field pins the extension ID while developing unpacked (the backend's
# sign-in allowlist knows that ID). The Chrome Web Store refuses a `key` on the
# FIRST upload and assigns its own ID, so the store zip carries none. After the
# first upload, the store's ID goes into the backend's EXTENSION_IDS.
$storeManifest = Get-Content -Raw manifest.json | ConvertFrom-Json
$storeManifest.PSObject.Properties.Remove('key')
$storeManifest | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8NoBOM (Join-Path $stage 'manifest.json')

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
Remove-Item $stage -Recurse -Force

$sizeKb = [math]::Round((Get-Item $zip).Length / 1KB, 1)
Write-Host "Packaged HProxy extension v$version -> $zip ($sizeKb KB, no key field)"
Write-Host "Upload this zip at https://chrome.google.com/webstore/devconsole"
