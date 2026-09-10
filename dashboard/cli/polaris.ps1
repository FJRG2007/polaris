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

# Run a native command with stderr discarded and its stdout returned.
#
# Windows PowerShell 5.1 turns a native command's stderr into ErrorRecords as soon
# as that stream is redirected, and this script runs under
# $ErrorActionPreference = "Stop", which makes them terminating. `docker logs`
# relays the container's own stderr, so reading a log to diagnose a fault would
# end in a PowerShell exception instead of the diagnosis - exactly when it is
# needed. The preference is lowered only for the moment the process runs.
function Get-Quiet {
    param([scriptblock]$Command)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { & $Command 2>&1 }
    finally { $ErrorActionPreference = $previous }
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
            $logs = Get-Quiet { docker logs --tail 40 polaris-web-1 } | Out-String
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

# ---------------------------------------------------------------------------
# Deploy, from anywhere
#
# The same commands as the POSIX script, over the Deploy API with an API key.
# `polaris login` keeps the address and the key in the user's own profile, with
# the key encrypted for this Windows account (DPAPI), so another account on the
# machine cannot read it. POLARIS_URL and POLARIS_TOKEN override the stored
# sign-in for a CI job. An argument with a slash, or an id, is a Deploy service;
# anything else keeps meaning a container of this stack.
# ---------------------------------------------------------------------------

$configDir = if ($env:POLARIS_CONFIG_DIR) { $env:POLARIS_CONFIG_DIR } else { Join-Path $env:APPDATA "polaris" }
$configFile = Join-Path $configDir "cli.json"

function Stop-WithError {
    param([string]$Message)
    Write-Host "polaris: $Message" -ForegroundColor Red
    exit 1
}

function Test-DeployRef {
    param([string]$Value)
    return ($Value -match "/") -or ($Value -match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
}

function Get-ApiContext {
    $stored = $null
    if (Test-Path $configFile) { $stored = Get-Content $configFile -Raw | ConvertFrom-Json }
    $url = $env:POLARIS_URL
    if (-not $url -and $stored) { $url = $stored.url }
    $token = $env:POLARIS_TOKEN
    if (-not $token -and $stored -and $stored.token) {
        $secure = ConvertTo-SecureString $stored.token
        $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
    }
    $insecure = ($env:POLARIS_INSECURE -eq "1") -or ($stored -and $stored.insecure)
    if (-not $url -or -not $token) { Stop-WithError "not signed in to a Polaris - run 'polaris login'" }
    return @{ Url = $url.TrimEnd("/"); Token = $token; Insecure = [bool]$insecure }
}

# One call to the API. A refusal is printed with the reason the API gave and
# ends the command; anything that is not an answer from Polaris says so.
function Invoke-Api {
    param(
        [hashtable]$Context,
        [string]$Method,
        [string]$Path,
        [hashtable]$Body
    )
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
    if ($Context.Insecure) {
        [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
    }
    $arguments = @{
        Uri = "$($Context.Url)$Path"
        Method = $Method
        Headers = @{ Authorization = "Bearer $($Context.Token)" }
        UseBasicParsing = $true
    }
    if ($Body) {
        $arguments.Body = [System.Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Compress))
        $arguments.ContentType = "application/json; charset=utf-8"
    }
    try {
        return Invoke-RestMethod @arguments
    }
    catch {
        $status = 0
        if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
        if ($status -eq 401) { Stop-WithError "the key was refused - it may be revoked or expired; run 'polaris login'" }
        # Windows PowerShell 5.1 fills ErrorDetails for some failures and not
        # others, so the body is read off the response itself when it is empty.
        $said = $null
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $said = $_.ErrorDetails.Message }
        elseif ($_.Exception.Response) {
            try {
                $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                $said = $reader.ReadToEnd()
                $reader.Close()
            }
            catch { }
        }
        $reason = $null
        if ($said) {
            try { $reason = ($said | ConvertFrom-Json).error } catch { }
        }
        if ($reason) { Stop-WithError $reason }
        if ($status -gt 0) { Stop-WithError "the request failed with HTTP $status" }
        Stop-WithError "could not reach $($Context.Url)"
    }
}

function Resolve-Service {
    param([hashtable]$Context, [string]$Ref)
    if (-not $Ref) { $Ref = $env:POLARIS_SERVICE }
    if (-not $Ref) { Stop-WithError "name a service (project/service, project/environment/service or its id), or set POLARIS_SERVICE" }
    $answer = Invoke-Api $Context "GET" "/api/v1/deploy/services?ref=$([uri]::EscapeDataString($Ref))"
    return $answer.service.id
}

# The value after a flag in the remaining arguments, or the default.
function Get-Flag {
    param([string[]]$Arguments, [string]$Name, [string]$Default = "")
    for ($i = 0; $i -lt $Arguments.Count - 1; $i++) {
        if ($Arguments[$i] -eq $Name) { return $Arguments[$i + 1] }
    }
    return $Default
}

# The arguments that are neither a flag nor a flag's value.
function Get-Positional {
    param([string[]]$Arguments)
    $valued = @("--tail", "--port", "--cert", "--context", "--dockerfile", "--platform")
    $out = @()
    for ($i = 0; $i -lt $Arguments.Count; $i++) {
        $arg = $Arguments[$i]
        if ($valued -contains $arg) { $i++; continue }
        if ($arg.StartsWith("-")) { continue }
        $out += $arg
    }
    return , $out
}

function Test-Follow {
    param([string[]]$Arguments)
    return ($Arguments -contains "--follow") -or ($Arguments -contains "-f")
}

# A deployment's build log as it is written. Windows PowerShell 5.1 cannot
# stream a response, so this reads from where the last read ended until the
# deployment has finished.
function Watch-Build {
    param([hashtable]$Context, [string]$DeploymentId)
    $offset = 0
    while ($true) {
        $answer = Invoke-Api $Context "GET" "/api/v1/deploy/deployments/$DeploymentId`?offset=$offset"
        if ($answer.log) { [Console]::Out.Write($answer.log) }
        $offset = $answer.nextOffset
        if ($answer.done -and -not $answer.log) {
            Write-Host ""
            Write-Host "[polaris] deployment $($answer.status)" -ForegroundColor $(if ($answer.status -eq "failed") { "Red" } else { "Green" })
            if ($answer.error) { Write-Host $answer.error -ForegroundColor Red }
            return
        }
        if (-not $answer.log) { Start-Sleep -Seconds 2 }
    }
}

function Invoke-Login {
    param([string[]]$Arguments)
    $positional = Get-Positional $Arguments
    $url = if ($positional.Count -gt 0) { $positional[0] } else { Read-Host "Polaris address (https://...)" }
    $url = $url.TrimEnd("/")
    if ($url -notmatch "^https?://") { Stop-WithError "the address must start with https:// (or http:// on a trusted network)" }
    $insecure = $Arguments -contains "--insecure"
    if ($env:POLARIS_TOKEN) {
        $token = $env:POLARIS_TOKEN
    }
    else {
        $secure = Read-Host "API key (Account > API keys)" -AsSecureString
        $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
    }
    if (-not $token) { Stop-WithError "no key was given" }
    if ($insecure) { Write-Host "polaris: certificate checks are OFF for $url - only do this for an address you control" -ForegroundColor Yellow }

    $me = Invoke-Api @{ Url = $url; Token = $token; Insecure = $insecure } "GET" "/api/v1/me"
    if (-not (Test-Path $configDir)) { New-Item -ItemType Directory -Path $configDir | Out-Null }
    $protected = ConvertTo-SecureString $token -AsPlainText -Force | ConvertFrom-SecureString
    @{ url = $url; token = $protected; insecure = [bool]$insecure } | ConvertTo-Json | Set-Content -Path $configFile -Encoding UTF8
    Write-Host "Signed in to $url as $($me.user.name)." -ForegroundColor Green
}

function Show-Projects {
    param([hashtable]$Context, [string[]]$Arguments)
    $answer = Invoke-Api $Context "GET" "/api/v1/deploy/projects"
    $rows = foreach ($project in $answer.projects) {
        foreach ($environment in $project.environments) {
            foreach ($service in $environment.services) {
                [pscustomobject]@{
                    Service = "$($project.slug)/$($environment.slug)/$($service.slug)"
                    Status = $service.status
                    Id = $service.id
                }
            }
        }
    }
    if ($Arguments -contains "--quiet") { $rows | ForEach-Object { $_.Service }; return }
    $rows | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
}

function Invoke-DeployNow {
    param([hashtable]$Context, [string[]]$Arguments)
    $positional = Get-Positional $Arguments
    $id = Resolve-Service $Context $(if ($positional.Count -gt 0) { $positional[0] } else { "" })
    if ($Arguments -contains "--local") {
        $deploymentId = Invoke-LocalBuild $Context $id $Arguments
    }
    else {
        $deploymentId = (Invoke-Api $Context "POST" "/api/v1/deploy/services/$id/deploy").deploymentId
    }
    Write-Host "Deployment $deploymentId started."
    if (Test-Follow $Arguments) { Watch-Build $Context $deploymentId }
}

# Build here with this machine's own docker and send the image, rather than have
# Polaris build the service's source. The image is tagged under the service's
# release repository with a fresh tag, saved, gzipped to a temporary file and
# streamed up without being held in memory. Answers the deployment id.
function Invoke-LocalBuild {
    param([hashtable]$Context, [string]$Id, [string[]]$Arguments)
    Assert-Docker
    $contextDir = Get-Flag $Arguments "--context" "."
    $dockerfile = Get-Flag $Arguments "--dockerfile"
    $platform = Get-Flag $Arguments "--platform"
    if (-not (Test-Path $contextDir -PathType Container)) { Stop-WithError "$contextDir is not a folder" }
    $repository = (Invoke-Api $Context "GET" "/api/v1/deploy/services/$Id/image").repository
    $bytes = New-Object byte[] 6
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $image = "${repository}:" + (($bytes | ForEach-Object { $_.ToString("x2") }) -join "")
    $buildArgs = @("build", "-t", $image)
    if ($dockerfile) { $buildArgs += @("-f", $dockerfile) }
    if ($platform) { $buildArgs += @("--platform", $platform) }
    Write-Host "Building $image here..."
    & docker @buildArgs $contextDir
    if ($LASTEXITCODE -ne 0) { Stop-WithError "the build failed" }
    $tar = [System.IO.Path]::GetTempFileName()
    $archive = "$tar.gz"
    try {
        Write-Host "Saving it..."
        & docker save -o $tar $image
        if ($LASTEXITCODE -ne 0) { Stop-WithError "could not save the image" }
        # Only the upload needs the tag; the layers stay in this machine's cache.
        & docker image rm $image | Out-Null
        $in = [System.IO.File]::OpenRead($tar)
        $out = [System.IO.File]::Create($archive)
        $gzip = New-Object System.IO.Compression.GZipStream($out, [System.IO.Compression.CompressionLevel]::Fastest)
        try { $in.CopyTo($gzip) } finally { $gzip.Dispose(); $out.Dispose(); $in.Dispose() }
        Remove-Item $tar -Force
        $headers = @{ Authorization = "Bearer $($Context.Token)" }
        # What it was built from, when the folder is a git checkout.
        if (Get-Command git -ErrorAction SilentlyContinue) {
            $commit = "$(Get-Quiet { git -C $contextDir rev-parse HEAD } | Select-Object -First 1)".Trim()
            if ($commit -match '^[0-9a-f]{40}$') {
                $headers["x-polaris-commit"] = $commit
                $subject = "$(Get-Quiet { git -C $contextDir log -1 --pretty=%s } | Select-Object -First 1)"
                if ($subject.Length -gt 400) { $subject = $subject.Substring(0, 400) }
                if ($subject) { $headers["x-polaris-message"] = [uri]::EscapeDataString($subject) }
            }
        }
        $size = (Get-Item $archive).Length
        Write-Host "Sending $([Math]::Round($size / 1MB)) MB..."
        return Send-Archive $Context "/api/v1/deploy/services/$Id/image" $archive $headers
    }
    finally {
        Remove-Item $tar, $archive -Force -ErrorAction SilentlyContinue
    }
}

# POST a file as the body with its length declared and write buffering off, so
# Windows PowerShell streams it instead of reading gigabytes into memory first.
function Send-Archive {
    param([hashtable]$Context, [string]$Path, [string]$File, [hashtable]$Headers)
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
    if ($Context.Insecure) {
        [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
    }
    $request = [System.Net.HttpWebRequest]::Create("$($Context.Url)$Path")
    $request.Method = "POST"
    $request.ContentType = "application/gzip"
    $request.AllowWriteStreamBuffering = $false
    $request.Timeout = [System.Threading.Timeout]::Infinite
    $request.ReadWriteTimeout = 30 * 60 * 1000
    $request.ContentLength = (Get-Item $File).Length
    foreach ($name in $Headers.Keys) { $request.Headers[$name] = $Headers[$name] }
    $source = [System.IO.File]::OpenRead($File)
    try {
        $body = $request.GetRequestStream()
        try { $source.CopyTo($body) } finally { $body.Dispose() }
    }
    finally { $source.Dispose() }
    try {
        $response = $request.GetResponse()
    }
    catch [System.Net.WebException] {
        $response = $_.Exception.Response
        if (-not $response) { Stop-WithError "could not reach $($Context.Url)" }
    }
    $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
    $said = $reader.ReadToEnd()
    $reader.Close()
    $status = [int]$response.StatusCode
    if ($status -eq 401) { Stop-WithError "the key was refused - it may be revoked or expired; run 'polaris login'" }
    $answer = $null
    try { $answer = $said | ConvertFrom-Json } catch { }
    if ($status -lt 200 -or $status -ge 300) {
        if ($answer -and $answer.error) { Stop-WithError $answer.error }
        Stop-WithError "the request failed with HTTP $status"
    }
    return $answer.deploymentId
}

function Show-Deployments {
    param([hashtable]$Context, [string[]]$Arguments)
    $positional = Get-Positional $Arguments
    $id = Resolve-Service $Context $(if ($positional.Count -gt 0) { $positional[0] } else { "" })
    $answer = Invoke-Api $Context "GET" "/api/v1/deploy/services/$id/deployments"
    $answer.deployments | ForEach-Object {
        [pscustomobject]@{
            Deployment = $_.id
            Status = if ($_.isCurrent) { "$($_.status)*" } else { $_.status }
            Created = $_.createdAt
            Commit = if ($_.commitSha) { $_.commitSha.Substring(0, [Math]::Min(7, $_.commitSha.Length)) } else { "" }
            Rollback = if ($_.rollbackable) { "yes" } else { "no" }
        }
    } | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
}

function Show-BuildLog {
    param([hashtable]$Context, [string[]]$Arguments)
    $positional = Get-Positional $Arguments
    if ($positional.Count -eq 0) { Stop-WithError "name a deployment id (see 'polaris deployments <service>')" }
    if (Test-Follow $Arguments) { Watch-Build $Context $positional[0]; return }
    $answer = Invoke-Api $Context "GET" "/api/v1/deploy/deployments/$($positional[0])?tail=200"
    [Console]::Out.Write($answer.log)
    Write-Host ""
}

function Invoke-Rollback {
    param([hashtable]$Context, [string[]]$Arguments)
    $positional = Get-Positional $Arguments
    if ($positional.Count -eq 0) { Stop-WithError "name the deployment to roll back to (see 'polaris deployments <service>')" }
    $answer = Invoke-Api $Context "POST" "/api/v1/deploy/deployments/$($positional[0])/rollback"
    Write-Host "Rolling back as deployment $($answer.deploymentId)."
    if (Test-Follow $Arguments) { Watch-Build $Context $answer.deploymentId }
}

# A service's runtime logs; with --follow, the lines after the last one printed.
function Show-ServiceLogs {
    param([hashtable]$Context, [string[]]$Arguments)
    $positional = Get-Positional $Arguments
    $id = Resolve-Service $Context $positional[0]
    $tail = Get-Flag $Arguments "--tail" "200"
    $answer = Invoke-Api $Context "GET" "/api/v1/deploy/services/$id/logs?tail=$tail"
    if ($answer.log) { Write-Host $answer.log.TrimEnd() }
    if (-not (Test-Follow $Arguments)) { return }
    $stamp = '^(\d{4}-\d{2}-\d{2}T\S+)'
    $last = ($answer.log -split "`n" | Where-Object { $_ -match $stamp } | Select-Object -Last 1)
    if ($last -match $stamp) { $last = $Matches[1] } else { $last = "" }
    while ($true) {
        Start-Sleep -Seconds 2
        $query = if ($last) { "tail=1000&since=$([uri]::EscapeDataString($last))" } else { "tail=$tail" }
        $answer = Invoke-Api $Context "GET" "/api/v1/deploy/services/$id/logs?$query"
        if (-not $answer.log) { continue }
        Write-Host $answer.log.TrimEnd()
        $newest = ($answer.log -split "`n" | Where-Object { $_ -match $stamp } | Select-Object -Last 1)
        if ($newest -match $stamp) { $last = $Matches[1] }
    }
}

function Show-ServiceStatus {
    param([hashtable]$Context, [string]$Ref)
    $service = (Invoke-Api $Context "GET" "/api/v1/deploy/services/$(Resolve-Service $Context $Ref)").service
    Write-Host "$($service.project.slug)/$($service.environment.slug)/$($service.slug)  $($service.status)" -ForegroundColor White
    $source = if ($service.source.image) { $service.source.image } elseif ($service.source.repository) { $service.source.repository } else { $service.source.kind }
    Write-Host "  source   $source$(if ($service.source.branch) { " ($($service.source.branch))" })"
    Write-Host "  domains  $(($service.domains | ForEach-Object { $_.hostname }) -join ', ')"
    Write-Host "  id       $($service.id)"
}

function Invoke-Power {
    param([hashtable]$Context, [string]$Action, [string]$Ref)
    Invoke-Api $Context "POST" "/api/v1/deploy/services/$(Resolve-Service $Context $Ref)/$Action" | Out-Null
    Write-Host "$Action done."
}

function Invoke-Env {
    param([hashtable]$Context, [string[]]$Arguments)
    $positional = Get-Positional $Arguments
    $sub = if ($positional.Count -gt 0) { $positional[0] } else { "list" }
    $id = Resolve-Service $Context $(if ($positional.Count -gt 1) { $positional[1] } else { "" })
    $secret = -not ($Arguments -contains "--plain")
    switch ($sub) {
        "list" {
            (Invoke-Api $Context "GET" "/api/v1/deploy/services/$id/variables").variables | ForEach-Object {
                [pscustomobject]@{ Key = $_.key; Value = if ($_.isSecret) { "(secret)" } else { $_.value }; Id = $_.id }
            } | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
        }
        "set" {
            if ($positional.Count -lt 3 -or $positional[2] -notmatch "=") { Stop-WithError "usage: polaris env set <service> KEY=VALUE [--plain]" }
            $split = $positional[2].IndexOf("=")
            $key = $positional[2].Substring(0, $split)
            $value = $positional[2].Substring($split + 1)
            Invoke-Api $Context "POST" "/api/v1/deploy/services/$id/variables" @{ key = $key; value = $value; secret = $secret } | Out-Null
            Write-Host "saved $key"
        }
        "unset" {
            if ($positional.Count -lt 3) { Stop-WithError "usage: polaris env unset <service> KEY" }
            $match = (Invoke-Api $Context "GET" "/api/v1/deploy/services/$id/variables").variables | Where-Object { $_.key -eq $positional[2] }
            if (-not $match) { Stop-WithError "$($positional[2]) is not set on that service" }
            Invoke-Api $Context "DELETE" "/api/v1/deploy/variables/$($match.id)" | Out-Null
            Write-Host "removed $($positional[2])"
        }
        "import" {
            if ($positional.Count -lt 3) { Stop-WithError "usage: polaris env import <service> <file> [--plain]" }
            if (-not (Test-Path $positional[2])) { Stop-WithError "cannot read $($positional[2])" }
            $text = Get-Content $positional[2] -Raw
            $answer = Invoke-Api $Context "POST" "/api/v1/deploy/services/$id/variables/import" @{ text = $text; secret = $secret }
            Write-Host "imported $($answer.count)"
        }
        default { Stop-WithError "unknown 'env' command '$sub' - list, set, unset or import" }
    }
}

function Invoke-Domains {
    param([hashtable]$Context, [string[]]$Arguments)
    $positional = Get-Positional $Arguments
    $sub = if ($positional.Count -gt 0) { $positional[0] } else { "list" }
    $id = Resolve-Service $Context $(if ($positional.Count -gt 1) { $positional[1] } else { "" })
    switch ($sub) {
        "list" {
            (Invoke-Api $Context "GET" "/api/v1/deploy/services/$id/domains").domains | ForEach-Object {
                [pscustomobject]@{ Hostname = $_.hostname; Enabled = $_.enabled; Cert = $_.certificate; Port = $_.targetPort; Health = $_.health; Id = $_.id }
            } | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
        }
        "add" {
            $body = @{}
            if ($positional.Count -gt 2) { $body.hostname = $positional[2] }
            $port = Get-Flag $Arguments "--port"
            if ($port) {
                if ($port -notmatch '^\d+$') { Stop-WithError "--port takes a number" }
                $body.targetPort = [int]$port
            }
            $cert = Get-Flag $Arguments "--cert"
            if ($cert) { $body.certificate = $cert }
            $answer = Invoke-Api $Context "POST" "/api/v1/deploy/services/$id/domains" $body
            Write-Host $answer.hostname
        }
        "remove" {
            if ($positional.Count -lt 3) { Stop-WithError "usage: polaris domains remove <service> <hostname|id>" }
            $want = $positional[2]
            $match = (Invoke-Api $Context "GET" "/api/v1/deploy/services/$id/domains").domains | Where-Object { $_.hostname -eq $want -or $_.id -eq $want }
            if (-not $match) { Stop-WithError "$want is not attached to that service" }
            Invoke-Api $Context "DELETE" "/api/v1/deploy/domains/$($match.id)" | Out-Null
            Write-Host "removed $want"
        }
        default { Stop-WithError "unknown 'domains' command '$sub' - list, add or remove" }
    }
}

$firstRest = if ($Rest -and $Rest.Count -gt 0) { $Rest[0] } else { "" }
$deployRef = $firstRest -and (Test-DeployRef $firstRest)

switch ($Command) {
    "setup" { Show-SetupLink }
    "token" { Get-Setting "POLARIS_SETUP_TOKEN" }
    "status" {
        if ($deployRef) { Show-ServiceStatus (Get-ApiContext) $firstRest } else { Show-Status }
    }
    "ps" { Invoke-Compose @("ps") }
    "doctor" { Invoke-Doctor }
    "logs" {
        if ($deployRef) { Show-ServiceLogs (Get-ApiContext) $Rest } else { Invoke-Compose (@("logs") + $Rest) }
    }
    { $_ -in @("start", "up") } {
        if ($deployRef) { Invoke-Power (Get-ApiContext) "start" $firstRest } else { Invoke-Compose @("up", "-d") }
    }
    "stop" {
        if ($deployRef) { Invoke-Power (Get-ApiContext) "stop" $firstRest } else { Invoke-Compose @("stop") }
    }
    "restart" {
        if ($deployRef) { Invoke-Power (Get-ApiContext) "restart" $firstRest } else { Invoke-Compose (@("restart") + $Rest) }
    }
    "login" { Invoke-Login $Rest }
    "logout" {
        if (Test-Path $configFile) { Remove-Item $configFile -Force }
        Write-Host "Signed out. The key itself still works until it is revoked in Polaris."
    }
    "whoami" { Invoke-Api (Get-ApiContext) "GET" "/api/v1/me" | ConvertTo-Json -Depth 5 }
    "projects" { Show-Projects (Get-ApiContext) $Rest }
    "deploy" { Invoke-DeployNow (Get-ApiContext) $Rest }
    "deployments" { Show-Deployments (Get-ApiContext) $Rest }
    "build-log" { Show-BuildLog (Get-ApiContext) $Rest }
    "rollback" { Invoke-Rollback (Get-ApiContext) $Rest }
    "env" { Invoke-Env (Get-ApiContext) $Rest }
    "domains" { Invoke-Domains (Get-ApiContext) $Rest }
    "update" {
        $installer = Join-Path $installDir "dashboard\scripts\install.ps1"
        if (-not (Test-Path $installer)) {
            Write-Host "polaris: the installer is not at $installer" -ForegroundColor Red
            exit 1
        }
        # Name the deployment this command belongs to. Left unset, the installer
        # looks for one that is RUNNING, and a stopped deployment therefore reads
        # as none at all: it would clone a second checkout elsewhere and bring it
        # up against these same volumes.
        $env:POLARIS_INSTALL_DIR = $installDir
        & $installer @Rest
    }
    { $_ -in @("help", "--help", "-h") } {
        @"
polaris - manage a Polaris deployment, and deploy to one

This stack (on the host):
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

Deploy (from anywhere, with an API key):
  polaris login [url] [--insecure]     Sign in with an API key
  polaris logout                       Forget the stored key
  polaris whoami                       Who the key acts as
  polaris projects                     Every service you can reach
  polaris deploy <service> [--follow]  Deploy, and watch the build
  polaris deploy <service> --local [--context dir] [--dockerfile f] [--platform p]
                                       Build here with docker and send the image
  polaris deployments <service>        Recent deployments
  polaris build-log <id> [--follow]    A deployment's build log
  polaris rollback <id> [--follow]     Put an earlier deployment back
  polaris logs <service> [--follow] [--tail N]
  polaris status <service>             Status, source and domains
  polaris restart|stop|start <service>
  polaris env list|set|unset|import <service> ...
                  set KEY=VALUE [--plain]   unset KEY   import <file> [--plain]
  polaris domains list|add|remove <service> ...
                  add [hostname] [--port N] [--cert le|internal|none]   remove <hostname|id>

A service is project/service (default environment), project/environment/service
or its id. POLARIS_URL and POLARIS_TOKEN override the stored sign-in, and
POLARIS_SERVICE names the service for commands where it is left out.
"@ | Write-Host
    }
    default {
        Write-Host "polaris: unknown command '$Command' (try 'polaris help')" -ForegroundColor Red
        exit 1
    }
}
