# ============================================================================
# install.ps1 - install the prime dsh integration into a dsh harness home
# ============================================================================
# Copies the out-of-tree plugins, profiles, and agent preset into $DSH_HOME
# (default ~\.dsh) and appends the documented `prime:` settings section if it
# is not present yet. Idempotent: re-running refreshes files in place.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -DshHome D:\my-dsh
#
# Nothing outside the harness home is touched; the stock web/headless/acp
# profiles are never modified. Uninstall with uninstall.ps1.
# ============================================================================
[CmdletBinding()]
param(
  # Harness home. Defaults to $DSH_HOME, else ~\.dsh (matches dsh-home-paths).
  [string]$DshHome = $(if ($env:DSH_HOME -and $env:DSH_HOME.Trim() -ne '') { $env:DSH_HOME } else { Join-Path $HOME '.dsh' })
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Copy-Tree([string]$From, [string]$To) {
  New-Item -ItemType Directory -Force -Path $To | Out-Null
  Copy-Item -Path (Join-Path $From '*') -Destination $To -Recurse -Force
}

Write-Host "prime dsh integration - installing into $DshHome"

# ── sanity: this looks like a dsh home? ─────────────────────────────────────
if (-not (Test-Path (Join-Path $DshHome 'profiles'))) {
  Write-Warning "'$DshHome' has no profiles\ directory - creating it anyway (first run against a fresh home is fine)."
}

# ── plugins (out-of-tree repo) ──────────────────────────────────────────────
Copy-Tree (Join-Path $repoRoot 'plugins\prime') (Join-Path $DshHome 'plugins\prime')
Write-Host "  plugins\prime            installed"

# ── profiles ────────────────────────────────────────────────────────────────
foreach ($profileName in @('prime-web', 'prime-headless')) {
  Copy-Tree (Join-Path $repoRoot "profiles\$profileName") (Join-Path $DshHome "profiles\$profileName")
  Write-Host ("  profiles\{0,-13} installed" -f $profileName)
}

# ── agent preset ────────────────────────────────────────────────────────────
Copy-Tree (Join-Path $repoRoot 'agent-presets\prime-rlm') (Join-Path $DshHome '.agent-presets\prime-rlm')
Write-Host "  .agent-presets\prime-rlm installed"

# ── settings section (append once, marker-delimited) ────────────────────────
$settingsPath = Join-Path $DshHome 'settings.yaml'
$beginMarker = '# >>> prime-dsh-integration >>>'
$endMarker = '# <<< prime-dsh-integration <<<'
$section = @"
$beginMarker
# Prime Agent integration (out-of-tree plugins, prime-* profiles). Every
# namespace below is registered by a prime plugin and hot-reloads. Delete
# this block to fall back to plugin row defaults.
prime:
  channel: prime-alpha

  rlm:
    enabled: true
    envelopeWarnChars: 120000
    envelopeBudgetChars: 400000
    pinnedFacts: []

  kernel:
    python: python
    execTimeoutMs: 120000
    maxOutputChars: 200000

  budgets:
    session: { maxTokens: 2000000, maxTurns: 200, maxWallClockMs: 21600000 }
    children: { maxTotalTokens: 1000000, maxPerChildTokens: 250000, maxConcurrency: 4 }
    kill: null

  policy:
    classes:
      shell.exec: dangerous
      file.write: dangerous
      file.read: safe
      web.fetch: dangerous
      net.connect: forbidden
      pip.install: dangerous

  refine:
    approveGlobal: false
$endMarker
"@

if (Test-Path $settingsPath) {
  $existing = Get-Content $settingsPath -Raw
  if ($existing -match [regex]::Escape($beginMarker)) {
    Write-Host '  settings.yaml           prime section already present - left untouched'
  } else {
    Add-Content -Path $settingsPath -Value "`n$section" -Encoding UTF8
    Write-Host '  settings.yaml           prime section appended'
  }
} else {
  Set-Content -Path $settingsPath -Value $section -Encoding UTF8
  Write-Host '  settings.yaml           created with prime section'
}

# ── verify ──────────────────────────────────────────────────────────────────
$selftest = Join-Path $DshHome 'plugins\prime\tools\prime-ops.cjs'
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node -and (Test-Path $selftest)) {
  Write-Host ''
  & node $selftest selftest
  if ($LASTEXITCODE -eq 0) { Write-Host 'selftest passed' } else { Write-Warning 'selftest FAILED - see output above' }
} else {
  Write-Host '  (node not found or selftest missing - skipped verification)'
}

Write-Host ''
Write-Host 'Done. Next steps:'
Write-Host '  headless:  dsh --profile prime-headless "your task"'
Write-Host '  web:       start dsh --profile prime-web and pick the "Prime RLM" preset per session,'
Write-Host '             or set  agent-presets: { default: prime-rlm }  in settings.yaml.'
Write-Host '  ops:       node ~\.dsh\plugins\prime\tools\prime-ops.cjs verify <sessionId>'
