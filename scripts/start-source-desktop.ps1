$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$electronPath = Join-Path $projectRoot "node_modules\electron\dist\electron.exe"
$runtimePath = Join-Path $projectRoot "node_modules\electron\dist\Codex Relay.exe"
$rceditPath = Join-Path $projectRoot "node_modules\electron-winstaller\vendor\rcedit.exe"
$iconPath = Join-Path $projectRoot "assets\icon.ico"
$appUrl = "http://127.0.0.1:15723"

if (-not (Test-Path -LiteralPath $electronPath)) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show(
    "The source desktop runtime is missing. Install the project dependencies first.",
    "Codex Relay could not start",
    "OK",
    "Error"
  ) | Out-Null
  exit 1
}

if (-not (Test-Path -LiteralPath $rceditPath) -or -not (Test-Path -LiteralPath $iconPath)) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show(
    "The source desktop icon tools are missing. Reinstall the project dependencies first.",
    "Codex Relay could not start",
    "OK",
    "Error"
  ) | Out-Null
  exit 1
}

# A packaged Relay can keep serving stale bundled files on the shared port.
# Replace only a listener that identifies itself as Codex Relay.
try {
  $health = Invoke-RestMethod -Uri "$appUrl/health" -TimeoutSec 2
} catch {
  $health = $null
}

if ($health.app -eq "codex-relay") {
  $listener = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort 15723 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($listener) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
    $ownerPath = [string]$owner.ExecutablePath
    $isSourceRuntime = $ownerPath -and (
      [string]::Equals($ownerPath, $electronPath, [System.StringComparison]::OrdinalIgnoreCase) -or
      [string]::Equals($ownerPath, $runtimePath, [System.StringComparison]::OrdinalIgnoreCase)
    )
    $restartExisting = $ownerPath -and -not $isSourceRuntime
    if (-not $restartExisting -and $ownerPath) {
      $sourceFiles = @()
      foreach ($relative in @("desktop", "src", "public", "assets")) {
        $sourceFiles += Get-ChildItem -LiteralPath (Join-Path $projectRoot $relative) -File -Recurse -ErrorAction SilentlyContinue
      }
      $sourceFiles += Get-Item -LiteralPath (Join-Path $projectRoot "package.json"), $PSCommandPath -ErrorAction SilentlyContinue
      $latestSourceWrite = ($sourceFiles | Measure-Object LastWriteTime -Maximum).Maximum
      $ownerProcess = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
      $restartExisting = [bool]($ownerProcess -and $latestSourceWrite -and $latestSourceWrite -gt $ownerProcess.StartTime)
    }
    if ($restartExisting) {
      Stop-Process -Id $listener.OwningProcess -Force -ErrorAction Stop
      $deadline = (Get-Date).AddSeconds(8)
      do {
        Start-Sleep -Milliseconds 200
        $remaining = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort 15723 -State Listen -ErrorAction SilentlyContinue
      } while ($remaining -and (Get-Date) -lt $deadline)
    }
  }
}

$runtimeNeedsRefresh = -not (Test-Path -LiteralPath $runtimePath)
if (-not $runtimeNeedsRefresh) {
  $runtimeWrite = (Get-Item -LiteralPath $runtimePath).LastWriteTimeUtc
  $runtimeNeedsRefresh = (Get-Item -LiteralPath $electronPath).LastWriteTimeUtc -gt $runtimeWrite -or
    (Get-Item -LiteralPath $iconPath).LastWriteTimeUtc -gt $runtimeWrite -or
    (Get-Item -LiteralPath $PSCommandPath).LastWriteTimeUtc -gt $runtimeWrite
}

if ($runtimeNeedsRefresh) {
  $runtimeProcess = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { [string]::Equals([string]$_.ExecutablePath, $runtimePath, [System.StringComparison]::OrdinalIgnoreCase) } |
    Select-Object -First 1
  if ($runtimeProcess) {
    Stop-Process -Id $runtimeProcess.ProcessId -Force -ErrorAction Stop
    Start-Sleep -Milliseconds 400
  }
  $brandingDirectory = Join-Path $env:TEMP "codex-relay-source-runtime"
  $brandingRuntime = Join-Path $brandingDirectory "CodexRelay.exe"
  $brandingIcon = Join-Path $brandingDirectory "icon.ico"
  New-Item -ItemType Directory -Path $brandingDirectory -Force | Out-Null
  try {
    Copy-Item -LiteralPath $electronPath -Destination $brandingRuntime -Force
    Copy-Item -LiteralPath $iconPath -Destination $brandingIcon -Force
    & $rceditPath $brandingRuntime --set-icon $brandingIcon --set-version-string "ProductName" "Codex Relay" --set-version-string "FileDescription" "Codex Relay Source Desktop" --set-version-string "InternalName" "Codex Relay" --set-version-string "OriginalFilename" "Codex Relay.exe"
    if ($LASTEXITCODE -ne 0) {
      throw "Could not brand the Codex Relay source runtime."
    }
    Copy-Item -LiteralPath $brandingRuntime -Destination $runtimePath -Force
  } finally {
    Remove-Item -LiteralPath $brandingRuntime, $brandingIcon -Force -ErrorAction SilentlyContinue
  }
}

Start-Process -FilePath $runtimePath -ArgumentList ('"' + $projectRoot + '"') -WorkingDirectory $projectRoot
