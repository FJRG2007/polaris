# polaris - manage a Polaris dashboard deployment (Windows PowerShell). The
# Windows half of `cli/polaris`: the same commands, so anything that tells an
# operator to run `polaris setup` is true on every platform Polaris installs on.
# Installed as both `polaris` and `plr` by install.ps1, which bakes the
# deployment path into __POLARIS_INSTALL_DIR__; override with
# POLARIS_INSTALL_DIR.
#
# Windows PowerShell 5.1 is the floor, so nothing here uses PowerShell 7 syntax
# (no ternary, no `-SkipCertificateCheck`, no `&&`).

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Command = "help",
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$ErrorActionPreference = "Stop"

$installDir = if ($env:POLARIS_INSTALL_DIR) { $env:POLARIS_INSTALL_DIR } else { "__POLARIS_INSTALL_DIR__" }
$composeDir = Join-Path $installDir "dashboard\docker"
$envFile = Join-Path $composeDir ".env"

# Read a setting: the process environment first (inside a container), then the
# deployment's .env (on the host).
function Get-Setting {
    param([string]$Key)
    $fromEnv = [Environment]::GetEnvironmentVariable($Key)
    if ($fromEnv) { return $fromEnv }
    if (-not (Test-Path $envFile)) { return "" }
    foreach ($line in (Get-Content $envFile)) {
        if ($line -match "^$([regex]::Escape($Key))=(.*)$") { return $Matches[1] }
    }
    return ""
}

function Assert-Docker {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Host "polaris: docker is required for this command" -ForegroundColor Red
        exit 1
    }
}

function Invoke-Compose {
    param([string[]]$Arguments)
    Assert-Docker
    # Activate the deployment's profile through the environment, not just .env:
    # COMPOSE_PROFILES in .env is not honoured reliably across Compose versions,
    # which would leave the full edition's hostd unstarted.
    $env:COMPOSE_PROFILES = Get-Setting "COMPOSE_PROFILES"
    Push-Location $composeDir
    try { & docker compose @Arguments } finally { Pop-Location }
}

# The address of this deployment that actually opens from this machine. The
# configured one needs its name to resolve, which on Windows means the hosts
# entry an unelevated install could not write; the loopback address is matched by
# the dashboard's own router and always answers.
function Get-OpenUrl {
    $configured = Get-Setting "POLARIS_APP_URL"
    $mdnsHost = Get-Setting "POLARIS_MDNS_HOSTNAME"
    if (-not $mdnsHost) { $mdnsHost = "polaris" }
    try {
        $resolved = [System.Net.Dns]::GetHostAddresses("$mdnsHost.local")
        if ($resolved -and $configured) { return $configured }
    }
    catch { }
    return "https://127.0.0.1"
}

# Whether the edge answers at all. Any HTTP status back is an answer - a 404 means
# the proxy is up and the request carried the wrong hostname, which is a different
# fault from nothing listening. The certificate is self-signed until a domain
# points here, so validation is turned off for this one probe and restored after.
function Test-Site {
    $siteHost = Get-Setting "POLARIS_MDNS_HOSTNAME"
    if (-not $siteHost) { $siteHost = "polaris" }
    $previous = [System.Net.ServicePointManager]::ServerCertificateValidationCallback
    try {
        [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
        # 5.1 can still default to a protocol the edge does not offer.
        [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
        $request = [System.Net.HttpWebRequest]::Create("https://127.0.0.1/api/health")
        $request.Host = "$siteHost.local"
        $request.Timeout = 5000
        $request.AllowAutoRedirect = $false
        $response = $request.GetResponse()
        $response.Close()
        return $true
    }
    catch [System.Net.WebException] {
        return ($null -ne $_.Exception.Response)
    }
    catch { return $false }
    finally { [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $previous }
}

# One line per service with its health and restart count, plus a verdict - the
# raw compose table stays on `polaris ps`.
function Show-Status {
    Assert-Docker
    $ids = docker ps -a --filter "label=com.docker.compose.project=polaris" --format "{{.ID}}"
    Write-Host ""
    if (-not $ids) {
        Write-Host "  Polaris  stack status" -ForegroundColor White
        Write-Host ""
        Write-Host "  no containers found - the stack is not running." -ForegroundColor Yellow
        Write-Host "  start it with: polaris start" -ForegroundColor Cyan
        Write-Host ""
        return
    }

    Write-Host "  Polaris  stack status" -ForegroundColor White
    Write-Host ""
    $down = 0
    foreach ($id in $ids) {
        $format = '{{index .Config.Labels "com.docker.compose.service"}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.RestartCount}}'
        $parts = (docker inspect --format $format $id) -split "\|"
        $service = $parts[0]
        $state = $parts[1]
        $health = $parts[2]
        $restarts = 0
        if ($parts[3] -match '^\d+$') { $restarts = [int]$parts[3] }
        $human = docker ps -a --filter "id=$id" --format "{{.Status}}"

        $color = "DarkGray"
        $label = $state
        switch ($state) {
            "running" {
                if (-not $health -or $health -eq "healthy") {
                    $color = "Green"
                    $label = if ($health) { "running ($health)" } else { "running" }
                }
                elseif ($health -eq "starting") { $color = "Yellow"; $label = "starting" }
                else { $color = "Red"; $label = "running ($health)"; $down++ }
            }
            "restarting" { $color = "Red"; $label = "restarting"; $down++ }
            default { $color = "Red"; $down++ }
        }

        Write-Host ("  {0,-12} {1,-20} {2}" -f $service, $label, $human) -ForegroundColor $color
        if ($restarts -gt 0) {
            Write-Host "            restarted $restarts time(s) - check: polaris logs $service" -ForegroundColor Yellow
        }
    }

    Write-Host ""
    if ($down -eq 0) {
        Write-Host "  all services healthy  -  $(Get-OpenUrl)" -ForegroundColor Green
    }
    else {
        Write-Host "  $down service(s) not healthy - inspect logs: polaris logs web" -ForegroundColor Red
    }

    # Healthy containers are not the same as a reachable site: a bad site address
    # loops on certificate issuance and refuses connections while every container
    # reports healthy. So probe it the way a browser would.
    if (Test-Site) {
        Write-Host "  site reachable through the proxy" -ForegroundColor Green
    }
    else {
        Write-Host "  site NOT reachable through the proxy - check it: polaris logs traefik" -ForegroundColor Red
    }
    Write-Host ""
}

# Diagnose common faults without changing anything.
function Invoke-Doctor {
    $problems = 0

    $password = Get-Setting "POSTGRES_PASSWORD"
    $url = Get-Setting "POLARIS_DATABASE_URL"
    $urlPassword = ""
    if ($url -match "^[a-z]+://[^:]*:([^@]*)@") { $urlPassword = $Matches[1] }
    if ($password -and $urlPassword -and $password -ne $urlPassword) {
        Write-Host "  [fail] .env is inconsistent: POSTGRES_PASSWORD and the password in" -ForegroundColor Red
        Write-Host "         POLARIS_DATABASE_URL differ. The web will fail to authenticate."
        Write-Host "         Fix: re-run the installer, which puts them back in step."
        $problems++
    }

    if (Get-Command docker -ErrorAction SilentlyContinue) {
        $web = docker ps -a --filter "label=com.docker.compose.project=polaris" --filter "name=polaris-web-1" --format "{{.ID}}"
        if ($web) {
            $logs = docker logs --tail 40 polaris-web-1 2>&1 | Out-String
            if ($logs -match "P1000") {
                Write-Host "  [fail] the web container is hitting P1000 (database auth failed)." -ForegroundColor Red
                Write-Host "         The password in the postgres volume no longer matches .env."
                Write-Host "         Re-run the installer: it resets the role password without data loss."
                $problems++
            }
        }
        # The whole stack refuses to start without these, and the error names only
        # the first service that wanted one.
        foreach ($network in @("polaris-proxy", "polaris-hub")) {
            if (-not (docker network ls --filter "name=^$network$" --format "{{.Name}}")) {
                Write-Host "  [fail] the $network network does not exist; compose will refuse to start." -ForegroundColor Red
                Write-Host "         Re-run the installer, which creates it."
                $problems++
            }
        }
    }

    $site = Get-Setting "POLARIS_SITE_ADDRESS"
    $appUrl = Get-Setting "POLARIS_APP_URL"
    if ("$site$appUrl" -match "example\.com") {
        Write-Host "  [fail] POLARIS_SITE_ADDRESS / POLARIS_APP_URL still use the placeholder" -ForegroundColor Red
        Write-Host "         example.com. Certificate issuance loops on it and the site stays"
        Write-Host "         unreachable even though the containers are healthy."
        $problems++
    }

    if ($problems -eq 0) {
        Write-Host "  no known problems detected" -ForegroundColor Green
    }
    else {
        Write-Host ""
        Write-Host "  $problems problem(s) found" -ForegroundColor Yellow
    }
}

function Show-SetupLink {
    $token = Get-Setting "POLARIS_SETUP_TOKEN"
    if (-not $token) {
        Write-Host "polaris: setup is already complete (no setup token available)."
        return
    }
    Write-Host "Open this link to create the administrator:"
    Write-Host "  $(Get-OpenUrl)/oauth/setup?token=$token" -ForegroundColor Yellow
}

switch ($Command) {
    "setup" { Show-SetupLink }
    "token" { Get-Setting "POLARIS_SETUP_TOKEN" }
    "status" { Show-Status }
    "ps" { Invoke-Compose @("ps") }
    "doctor" { Invoke-Doctor }
    "logs" { Invoke-Compose (@("logs") + $Rest) }
    { $_ -in @("start", "up") } { Invoke-Compose @("up", "-d") }
    "stop" { Invoke-Compose @("stop") }
    "restart" { Invoke-Compose (@("restart") + $Rest) }
    "update" {
        $installer = Join-Path $installDir "dashboard\scripts\install.ps1"
        if (-not (Test-Path $installer)) {
            Write-Host "polaris: the installer is not at $installer" -ForegroundColor Red
            exit 1
        }
        & $installer @Rest
    }
    { $_ -in @("help", "--help", "-h") } {
        @"
polaris - manage a Polaris deployment

  polaris setup        Print the link to create the administrator
  polaris token        Print the current setup token
  polaris status       Show a clean, colored view of every service
  polaris ps           Show the raw docker compose status table
  polaris doctor       Diagnose common faults (e.g. database auth mismatch)
  polaris logs [svc]   Show container logs
  polaris start        Start the stack
  polaris stop         Stop the stack
  polaris restart [s]  Restart the stack (or one service)
  polaris update       Pull the latest and redeploy
"@ | Write-Host
    }
    default {
        Write-Host "polaris: unknown command '$Command' (try 'polaris help')" -ForegroundColor Red
        exit 1
    }
}
