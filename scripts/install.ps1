param(
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Push-Location $Root
try {
  pnpm install --frozen-lockfile
  if (-not $SkipBuild) {
    if (Test-Path "packages/plugin/dist") {
      $Backup = Join-Path $Root ".dsh-fusion-backups" (Get-Date -Format "yyyyMMdd-HHmmss")
      New-Item -ItemType Directory -Path $Backup -Force | Out-Null
      Copy-Item -LiteralPath "packages/plugin/dist" -Destination $Backup -Recurse
    }
    pnpm build
  }
  node scripts/doctor.mjs
} finally {
  Pop-Location
}
