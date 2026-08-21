# ============================================================================
# uninstall.ps1 - remove the prime dsh integration from a dsh harness home
# ============================================================================
# Deletes the installed plugins, profiles, and agent preset, and removes the
# marker-delimited `prime:` settings block. Session sidecar journals and
# artifacts under <home>\storages\prime\ are KEPT by default (they are your
# audit trail); pass -PurgeData to delete them too.
#
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 -PurgeData
# ============================================================================
[CmdletBinding()]
param(
  [string]$DshHome = $(if ($env:DSH_HOME -and $env:DSH_HOME.Trim() -ne '') { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }),
  [switch]$PurgeData
)

$ErrorActionPreference = 'Stop'

$targets = @(
  (Join-Path $DshHome 'plugins\prime'),
  (Join-Path $DshHome 'profiles\prime-web'),
  (Join-Path $DshHome 'profiles\prime-headless'),
  (Join-Path $DshHome '.agent-presets\prime-rlm')
)

foreach ($target in $targets) {
  if (Test-Path $target) {
    Remove-Item $target -Recurse -Force
    Write-Host "removed $target"
  }
}

$settingsPath = Join-Path $DshHome 'settings.yaml'
if (Test-Path $settingsPath) {
  $lines = Get-Content $settingsPath
  $begin = ($lines | Select-String -SimpleMatch '# >>> prime-dsh-integration >>>').LineNumber
  $end = ($lines | Select-String -SimpleMatch '# <<< prime-dsh-integration <<<').LineNumber
  if ($begin -and $end -and $end -gt $begin) {
    $kept = $lines[0..($begin - 2)] + $lines[$end..($lines.Count - 1)]
    Set-Content -Path $settingsPath -Value ($kept -join "`n") -Encoding UTF8
    Write-Host "removed prime section from $settingsPath"
  } else {
    Write-Host "no prime section found in $settingsPath"
  }
}

if ($PurgeData) {
  $data = Join-Path $DshHome 'storages\prime'
  if (Test-Path $data) {
    Remove-Item $data -Recurse -Force
    Write-Host "purged $data"
  }
} else {
  Write-Host "kept $($DshHome)\storages\prime\ (journals, artifacts, refinements). Pass -PurgeData to delete."
}

Write-Host 'prime integration uninstalled. Default dsh profiles were never modified.'
