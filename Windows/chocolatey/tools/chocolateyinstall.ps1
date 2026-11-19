# hproxy, the command-line tool: downloads the program of the GitHub release cli-v@VERSION@ for this processor,
# checked against its SHA-256 from that release's SHA256SUMS, into this package's folder. Chocolatey puts it on the
# PATH as hproxy and removes it again on uninstall. Filled by .github/workflows/chocolatey.yml for each release.
$ErrorActionPreference = 'Stop'
$toolsDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$release = 'https://github.com/hproxy-com/proxy-all-in-one-tool/releases/download/cli-v@VERSION@'

$packageArgs = @{
  packageName    = $env:ChocolateyPackageName
  fileFullPath   = Join-Path $toolsDir 'hproxy.exe'
  url            = "$release/hproxy-cli-windows-x86.exe"
  checksum       = '@SHA_X86@'
  checksumType   = 'sha256'
  url64bit       = "$release/hproxy-cli-windows-x86_64.exe"
  checksum64     = '@SHA_X64@'
  checksumType64 = 'sha256'
}

# Windows on ARM gets the ARM64 program, which runs there natively. An x64 program running emulated on ARM sees
# AMD64 in its own environment, so the machine's value (from the registry) is asked as well. --x86 still gets the
# 32-bit program, since only the 64-bit choice changes here.
$machine = @($env:PROCESSOR_ARCHITECTURE, $env:PROCESSOR_ARCHITEW6432,
  [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITECTURE', 'Machine'))
if ($machine -contains 'ARM64') {
  $packageArgs.url64bit = "$release/hproxy-cli-windows-arm64.exe"
  $packageArgs.checksum64 = '@SHA_ARM64@'
}

Get-ChocolateyWebFile @packageArgs
