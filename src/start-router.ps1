$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

# Third-party requests must follow their configured provider URL directly.
# The official-only fetcher reads the current Windows proxy at request time.
Remove-Item Env:HTTP_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:ALL_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:NODE_USE_ENV_PROXY -ErrorAction SilentlyContinue
& node.exe src\server.js
