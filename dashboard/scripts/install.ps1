# Polaris dashboard one-command installer AND updater (Windows PowerShell). Run
# the same line to set up or to update: it pulls the latest source, adds any new
# settings to .env automatically, rebuilds, and restarts (applying migrations).
#
#   irm https://raw.githubusercontent.com/FJRG2007/polaris/main/dashboard/scripts/install.ps1 | iex
#
# One command, no options: an install is an install, the same one every time.
#
# Idempotent and non-destructive: never overwrites an existing .env. All logic
# lives in a function that returns (never `exit`) so piping into `iex` cannot
# close the caller's session.

function Invoke-PolarisInstall {
    [CmdletBinding()]
    param()

    $ErrorActionPreference = "Stop"
    $repoUrl = if ($env:POLARIS_REPO_URL) { $env:POLARIS_REPO_URL } else { "https://github.com/FJRG2007/polaris.git" }
    # Fixed, machine-wide default (ProgramData) so the same command resolves to the
    # same place regardless of which user runs it; a running deployment is found via
    # Docker regardless (see below).
    $installDir = if ($env:POLARIS_INSTALL_DIR) { $env:POLARIS_INSTALL_DIR } else { Join-Path $env:ProgramData "Polaris" }

    function Write-Log { param($Message) Write-Host "polaris: $Message" }

    function Test-Command {
        param($Name)
        return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
    }

    if (-not (Test-Command "docker")) {
        Write-Error "docker not found. Install Docker Desktop: https://docs.docker.com/desktop/install/windows-install/"
        return
    }

    # Require the Compose v2 plugin (legacy docker-compose is unsupported).
    docker compose version *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Error "'docker compose' (v2) is required but not available. Update Docker Desktop."
        return
    }

    # New-Secret: cryptographically random bytes, base64 or hex encoded.
    # Uses RandomNumberGenerator.Create().GetBytes(): the static Fill() overload
    # only exists on .NET Core, so under Windows PowerShell 5.1 (.NET Framework) it
    # throws a non-terminating error and would silently leave the buffer all-zero -
    # a predictable master key. The instance GetBytes() works on both runtimes.
    function New-Secret {
        param([int]$Bytes = 32, [switch]$Hex)
        $buffer = New-Object 'System.Byte[]' $Bytes
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
        if ($Hex) {
            return -join ($buffer | ForEach-Object { $_.ToString("x2") })
        }
        return [System.Convert]::ToBase64String($buffer)
    }

    # Durable store for generated secrets, kept outside .env so a deleted or
    # regenerated .env reuses the same POLARIS_MASTER_KEY instead of minting a new
    # one that would orphan already-encrypted credentials in the persistent
    # database. Override the location with POLARIS_SECRETS_FILE.
    if ($env:POLARIS_SECRETS_FILE) {
        $script:SecretsStore = $env:POLARIS_SECRETS_FILE
    }
    else {
        $script:SecretsStore = Join-Path $env:ProgramData "Polaris\secrets.env"
    }

    # Read a remembered secret's value for a key (empty string if none).
    function Get-StoredSecret {
        param([string]$Key)
        if (-not (Test-Path $script:SecretsStore)) { return "" }
        foreach ($line in (Get-Content $script:SecretsStore)) {
            if ($line -match "^$([regex]::Escape($Key))=(.*)$") { return $Matches[1] }
        }
        return ""
    }

    # Persist Key=Value in the store, replacing any prior line for that key.
    function Set-StoredSecret {
        param([string]$Key, [string]$Value)
        $dir = Split-Path -Parent $script:SecretsStore
        if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        $lines = @()
        if (Test-Path $script:SecretsStore) {
            $lines = @(Get-Content $script:SecretsStore | Where-Object { $_ -notmatch "^$([regex]::Escape($Key))=" })
        }
        $lines += "$Key=$Value"
        [System.IO.File]::WriteAllText($script:SecretsStore, (($lines -join "`n") + "`n"))
    }

    # Recover a secret from a Polaris deployment already running on this host (its
    # web container's environment). Docker volumes are global to the `polaris`
    # compose project, so reusing the live master key stops a fresh .env from
    # orphaning the database's encrypted credentials. Empty if none is running.
    function Get-RunningSecret {
        param([string]$Key)
        if (-not (Test-Command "docker")) { return "" }
        $cid = (docker ps -q --filter "label=com.docker.compose.project=polaris" --filter "label=com.docker.compose.service=web" 2>$null | Select-Object -First 1)
        if (-not $cid) { return "" }
        $envLines = docker inspect $cid --format '{{range .Config.Env}}{{println .}}{{end}}' 2>$null
        foreach ($line in $envLines) {
            if ($line -match "^$([regex]::Escape($Key))=(.*)$") { return $Matches[1] }
        }
        return ""
    }

    # The host directory (compose working dir) of a running Polaris deployment, so
    # a bare install updates that one in place instead of a divergent checkout.
    function Get-RunningDeploymentDir {
        if (-not (Test-Command "docker")) { return "" }
        $cid = (docker ps -q --filter "label=com.docker.compose.project=polaris" --filter "label=com.docker.compose.service=web" 2>$null | Select-Object -First 1)
        if (-not $cid) { return "" }
        return (docker inspect $cid --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>$null | Select-Object -First 1)
    }

    # Reuse a remembered secret for Key, else adopt the value from a Polaris
    # deployment already running here, else generate one. Each source is
    # remembered. This makes a regenerated .env - or a fresh checkout in another
    # directory - recover the SAME master key.
    function Get-DurableSecret {
        param([string]$Key, [int]$Bytes, [switch]$Hex)
        $existing = Get-StoredSecret $Key
        if ($existing) { return $existing }
        $recovered = Get-RunningSecret $Key
        if ($recovered) { Set-StoredSecret $Key $recovered; return $recovered }
        if ($Hex) { $value = New-Secret -Bytes $Bytes -Hex } else { $value = New-Secret -Bytes $Bytes }
        Set-StoredSecret $Key $value
        return $value
    }

    # First run of this hardened installer: capture the CURRENT durable secrets
    # from an existing .env so a later .env loss recovers them. Never overwrites a
    # value already in the store, and ignores unresolved REPLACE_ME placeholders.
    function Import-EnvSecretsToStore {
        foreach ($key in @("POLARIS_MASTER_KEY", "POLARIS_AUTH_SECRET", "POSTGRES_PASSWORD")) {
            if (Get-StoredSecret $key) { continue }
            $cur = ""
            foreach ($line in (Get-Content ".env")) {
                if ($line -match "^$([regex]::Escape($key))=(.*)$") { $cur = $Matches[1]; break }
            }
            if (-not $cur -or $cur -like "REPLACE_ME_*") { continue }
            Set-StoredSecret $key $cur
        }
    }

    # Turn a known secret placeholder into a value, or pass it through. Durable
    # secrets are reused from the store; Key is the .env key being filled.
    function Get-Materialized {
        param([string]$Key, $Value)
        switch ($Value) {
            "REPLACE_ME_openssl_rand_base64_32" { return (Get-DurableSecret -Key $Key -Bytes 32) }
            "REPLACE_ME_long_random_string" { return (Get-DurableSecret -Key $Key -Bytes 48) }
            "REPLACE_ME_strong_password" { return (Get-DurableSecret -Key $Key -Bytes 24 -Hex) }
            "REPLACE_ME_setup_token" { return (New-Secret -Bytes 24 -Hex) }
            default { return $Value }
        }
    }

    # Append any settings added in a newer version to an existing .env (generating
    # their secrets), so re-running to update never needs manual .env edits.
    function Sync-Env {
        $present = @{}
        foreach ($line in (Get-Content ".env")) {
            if ($line -match "^([^#=]+)=") { $present[$Matches[1]] = $true }
        }
        $added = @()
        foreach ($line in (Get-Content ".env.example")) {
            if ($line -match "^\s*#") { continue }
            if ($line -notmatch "^([^=]+)=(.*)$") { continue }
            $key = $Matches[1]
            if (-not $present.ContainsKey($key)) {
                $value = Get-Materialized $key $Matches[2]
                Add-Content -Path ".env" -Value "$key=$value"
                $added += $key
            }
        }
        if ($added.Count -gt 0) { Write-Log ("added new settings to .env: " + ($added -join ", ")) }
    }

    # Replace a setting in .env in place (appending it when it is not there yet),
    # leaving every other line untouched.
    function Set-EnvValue {
        param([string]$Path, [string]$Key, [string]$Value)
        $pattern = "^$([regex]::Escape($Key))="
        $kept = @(Get-Content $Path | Where-Object { $_ -notmatch $pattern })
        $kept += "$Key=$Value"
        [System.IO.File]::WriteAllText($Path, (($kept -join "`n") + "`n"))
    }

    # Write the compose profile into .env, so every `docker compose` after this
    # one - the CLI, the next update - runs the same set of services.
    #
    # The in-band update command install.sh writes alongside it stays empty here.
    # It exists to be run BY hostd, which is a Linux container: it bind-mounts the
    # checkout into a throwaway updater by a path the Docker daemon resolves on
    # its own side, and a Windows path is not one of those. Rather than write a
    # command that would fail at the moment an operator needs it most, the update
    # path on this machine is `polaris update`, which the installer says.
    function Set-Edition {
        param([string]$EnvPath)
        Set-EnvValue -Path $EnvPath -Key "POLARIS_HOSTD_UPDATE_CMD" -Value ""
        Set-EnvValue -Path $EnvPath -Key "COMPOSE_PROFILES" -Value "full"
        Write-Log "update this deployment with 'polaris update'"
    }

    # Map polaris / polaris.local to loopback on this machine so they resolve even
    # without mDNS. Best effort and idempotent; editing hosts needs Administrator.
    # Returns whether those names resolve here, because everything this installer
    # prints afterwards has to be a link that opens: without the entry (the usual
    # case, since `irm | iex` is rarely elevated) polaris.local resolves nowhere and
    # a setup link naming it is a dead end.
    function Set-PolarisHostnames {
        $hostsPath = Join-Path $env:SystemRoot "System32\drivers\etc\hosts"
        $marker = "# polaris-dashboard"
        try {
            if (Select-String -Path $hostsPath -SimpleMatch $marker -ErrorAction SilentlyContinue) { return $true }
            Add-Content -Path $hostsPath -Value "127.0.0.1 polaris polaris.local $marker" -ErrorAction Stop
            Write-Log "mapped polaris and polaris.local to 127.0.0.1 in hosts"
            return $true
        }
        catch {
            Write-Host "polaris: could not edit hosts (run as Administrator to enable 'polaris'/'polaris.local'); the dashboard is reachable at https://127.0.0.1 either way" -ForegroundColor Yellow
            return $false
        }
    }

    # Install the `polaris` (and `plr`) command, the way install.sh does on
    # Linux and macOS: every screen and message that names it has to be true here
    # too. The deployment path is baked in, so the command works from any
    # directory. Installed for this user - a machine-wide location would need
    # Administrator, which `irm | iex` almost never has - and the shim is a .cmd
    # so it runs from cmd.exe and PowerShell alike.
    function Install-PolarisCli {
        param([string]$RepoRoot)
        $source = Join-Path $RepoRoot "dashboard\cli\polaris.ps1"
        if (-not (Test-Path $source)) { return }
        $binDir = Join-Path $env:LOCALAPPDATA "Polaris\bin"
        if (-not (Test-Path $binDir)) { New-Item -ItemType Directory -Force -Path $binDir | Out-Null }

        $script = (Get-Content $source -Raw).Replace("__POLARIS_INSTALL_DIR__", $RepoRoot)
        [System.IO.File]::WriteAllText((Join-Path $binDir "polaris.ps1"), $script)
        [System.IO.File]::WriteAllText((Join-Path $binDir "plr.ps1"), $script)
        # -File, not -Command: it passes the arguments through untouched and does
        # not need the user's execution policy to allow a policy-scoped script.
        $shim = "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0polaris.ps1`" %*`r`n"
        [System.IO.File]::WriteAllText((Join-Path $binDir "polaris.cmd"), $shim)
        [System.IO.File]::WriteAllText((Join-Path $binDir "plr.cmd"), $shim)

        # On PATH for future sessions, and for this one, so the link printed below
        # is not the only way in.
        $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
        if (($userPath -split ";") -notcontains $binDir) {
            $updated = if ($userPath) { "$userPath;$binDir" } else { $binDir }
            [Environment]::SetEnvironmentVariable("Path", $updated, "User")
            Write-Log "installed the 'polaris' (and 'plr') command; open a new terminal to use it"
        }
        if (($env:Path -split ";") -notcontains $binDir) { $env:Path = "$env:Path;$binDir" }
    }

    # Locate the compose directory: run in place inside a checkout, otherwise
    # clone (or fast-forward) one into the install dir.
    if ((Test-Path "docker/docker-compose.yml") -and (Test-Path "docker/.env.example")) {
        $workdir = "docker"
    }
    elseif ((Test-Path "docker-compose.yml") -and (Test-Path ".env.example")) {
        $workdir = "."
    }
    else {
        # Prefer a deployment already running on this host: update IT in place so a
        # bare install (from any directory) never spins up a second, divergent
        # checkout with a fresh master key against the shared Docker volumes.
        $runningDir = Get-RunningDeploymentDir
        if ($runningDir -and (Test-Path (Join-Path $runningDir "docker-compose.yml"))) {
            $installDir = (Resolve-Path (Join-Path $runningDir "..\..")).Path
            Write-Log "found the running Polaris deployment at $installDir; updating it in place"
        }
        if (-not (Test-Command "git")) {
            Write-Error "git not found. Install git so the installer can fetch the Polaris repository."
            return
        }
        if (Test-Path (Join-Path $installDir ".git")) {
            Write-Log "updating existing checkout in $installDir"
            git -C $installDir pull --ff-only
        }
        else {
            Write-Log "cloning $repoUrl into $installDir"
            git clone --depth 1 $repoUrl $installDir
        }
        $workdir = Join-Path $installDir "dashboard/docker"
    }

    # The checkout the deployment runs from, resolved before anything changes the
    # current directory: the CLI has this path baked into it.
    $repoRoot = (Resolve-Path (Join-Path $workdir "..\..")).Path

    Push-Location $workdir
    try {
        if (-not (Test-Path ".env")) {
            Write-Log "generating .env with fresh secrets"
            # Durable across installs (reused from the secrets store), so a
            # regenerated .env keeps decrypting existing data. The setup token is
            # ephemeral (inert once an administrator exists).
            $masterKey = Get-DurableSecret -Key "POLARIS_MASTER_KEY" -Bytes 32
            $authSecret = Get-DurableSecret -Key "POLARIS_AUTH_SECRET" -Bytes 48
            $pgPassword = Get-DurableSecret -Key "POSTGRES_PASSWORD" -Bytes 24 -Hex
            $setupToken = New-Secret -Bytes 24 -Hex

            $content = Get-Content ".env.example" -Raw
            $content = $content.Replace("REPLACE_ME_openssl_rand_base64_32", $masterKey)
            $content = $content.Replace("REPLACE_ME_long_random_string", $authSecret)
            $content = $content.Replace("REPLACE_ME_setup_token", $setupToken)
            $content = $content.Replace("REPLACE_ME_strong_password", $pgPassword)
            # Write UTF-8 without BOM so Docker reads the env_file cleanly.
            [System.IO.File]::WriteAllText((Join-Path (Get-Location) ".env"), $content)
            Write-Host "polaris: review .env and set POLARIS_SITE_ADDRESS / POLARIS_APP_URL to your domain" -ForegroundColor Yellow
        }
        else {
            Write-Log ".env present; reconciling any new settings"
            # Capture this host's current durable secrets before touching
            # anything, so its master key survives a future .env loss.
            Import-EnvSecretsToStore
            Sync-Env
        }

        # Keep POLARIS_DATABASE_URL's password in lockstep with POSTGRES_PASSWORD so
        # the two can never drift apart. Only touches a URL for the bundled postgres.
        $envLines = Get-Content ".env"
        $pgUser = (($envLines | Where-Object { $_ -match "^POSTGRES_USER=" } | Select-Object -First 1) -replace "^POSTGRES_USER=", "")
        $pgPass = (($envLines | Where-Object { $_ -match "^POSTGRES_PASSWORD=" } | Select-Object -First 1) -replace "^POSTGRES_PASSWORD=", "")
        $pgDb = (($envLines | Where-Object { $_ -match "^POSTGRES_DB=" } | Select-Object -First 1) -replace "^POSTGRES_DB=", "")
        $dbUrl = (($envLines | Where-Object { $_ -match "^POLARIS_DATABASE_URL=" } | Select-Object -First 1) -replace "^POLARIS_DATABASE_URL=", "")
        if ($pgPass -and $dbUrl -match "@postgres:5432/") {
            if (-not $pgUser) { $pgUser = "polaris" }
            if (-not $pgDb) { $pgDb = "polaris" }
            $desired = "postgresql://${pgUser}:${pgPass}@postgres:5432/${pgDb}"
            if ($dbUrl -ne $desired) {
                $updated = $envLines -replace "^POLARIS_DATABASE_URL=.*", "POLARIS_DATABASE_URL=$desired"
                [System.IO.File]::WriteAllLines((Join-Path (Get-Location) ".env"), $updated)
                Write-Log "kept POLARIS_DATABASE_URL consistent with POSTGRES_PASSWORD"
            }
        }

        $hostsMapped = Set-PolarisHostnames
        Install-PolarisCli -RepoRoot $repoRoot

        # Select the edition and WRITE it, the way install.sh does. Held only in
        # this process it would last exactly one run: the next one - the update
        # the operator runs later - would come up with no profile, and its
        # `--remove-orphans` would then delete the host daemon as a leftover,
        # quietly demoting a full deployment to limited.
        Set-Edition -EnvPath (Join-Path (Get-Location) ".env")
        # Exported as well as written: COMPOSE_PROFILES from .env is not honoured
        # reliably across Compose versions, and when it is ignored the host daemon
        # never starts - and `--remove-orphans` below then deletes it as a leftover.
        $env:COMPOSE_PROFILES = "full"

        # The two networks the compose file declares as `external`. Compose resolves
        # every network of every service it starts BEFORE starting one, so a missing
        # external network fails the whole `up` ("network polaris-proxy declared as
        # external, but could not be found"), not just the service that named it.
        # hostd creates polaris-proxy too, but it is started by the very `up` that
        # fails - and the limited edition has no hostd at all. Idempotent.
        docker network create polaris-proxy *> $null
        docker network create polaris-hub *> $null

        # Install and update are the same: prefer the published image, falling
        # back to a source build; the web entrypoint applies pending migrations.
        Write-Log "starting the stack (also applies database migrations)"
        docker compose pull 2>$null
        $buildFlag = @()
        if ($LASTEXITCODE -ne 0) { $buildFlag = @("--build") }

        # Bring the database up first and align its password with .env BEFORE the
        # web connects, so it authenticates cleanly the first time (no P1000 race).
        docker compose up -d @buildFlag postgres
        if ($pgPass -and $dbUrl -match "@postgres:5432/") {
            $esc = $pgPass -replace "'", "''"
            for ($i = 0; $i -lt 15; $i++) {
                docker compose exec -T postgres pg_isready -U $pgUser -d $pgDb *> $null
                if ($LASTEXITCODE -eq 0) {
                    docker compose exec -T postgres psql -U $pgUser -d $pgDb -c "ALTER USER `"$pgUser`" WITH PASSWORD '$esc';" *> $null
                    if ($LASTEXITCODE -eq 0) { Write-Log "aligned the database password with .env"; break }
                }
                Start-Sleep -Seconds 2
            }
        }

        # Now bring up the rest against the already-aligned database.
        docker compose up -d @buildFlag --remove-orphans

        # A deployment whose host daemon never started looks identical from the
        # dashboard except that this machine's own containers are simply not there.
        # The daemon needs a privileged container with shared mount propagation,
        # which Docker Desktop does not always allow, so this is a real outcome
        # here and not a theoretical one. Reported, never fatal - the rest of the
        # deployment is up and serving.
        if (-not (docker compose ps -q hostd 2>$null)) {
            Write-Host "polaris: the host daemon did not start; this machine's own containers will not appear" -ForegroundColor Red
            docker compose logs --tail 20 hostd
        }

        # The Caddyfile is bind-mounted, so `up -d` does not restart Caddy when it
        # changes. Reload its config live so proxy/TLS changes from an update take
        # effect; fall back to recreating the container if a reload is not possible.
        docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile *> $null
        if ($LASTEXITCODE -ne 0) { docker compose up -d --force-recreate caddy *> $null }

        $appUrl = (Get-Content ".env" | Where-Object { $_ -match "^POLARIS_APP_URL=" } | Select-Object -First 1) -replace "^POLARIS_APP_URL=", ""
        if (-not $appUrl) { $appUrl = "your configured POLARIS_APP_URL" }

        # Verify the deploy came up (health if the image has a healthcheck, else
        # "running") instead of reporting success blindly.
        $ready = $false
        for ($i = 0; $i -lt 45; $i++) {
            $wid = (docker compose ps -q web 2>$null)
            if ($wid) {
                $state = (docker inspect --format '{{.State.Status}}' $wid 2>$null)
                $health = (docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' $wid 2>$null)
                if (($health -and $health -eq "healthy") -or (-not $health -and $state -eq "running")) { $ready = $true; break }
                if ($state -eq "exited") { break }
            }
            Start-Sleep -Seconds 2
        }
        if (-not $ready) {
            Write-Host "polaris: the web service did not become healthy. Recent logs:" -ForegroundColor Red
            docker compose logs --tail 30 web
            Write-Host "polaris: diagnose with 'polaris doctor' (or 'polaris logs web')" -ForegroundColor Red
            return
        }

        # The address to hand over. The configured one only opens once its name
        # resolves here, which needs the hosts entry an unelevated run cannot write;
        # the loopback address is matched by the dashboard's own router and always
        # does. https, because :80 redirects there anyway.
        $openUrl = if ($hostsMapped) { $appUrl } else { "https://127.0.0.1" }
        Write-Log "done. Polaris is running at: $openUrl"
        Write-Host "polaris: the certificate is self-signed until you point a domain here, so the browser will warn once" -ForegroundColor Yellow

        # Only advertise the first-run setup link while setup is still pending.
        $userCount = (docker compose exec -T postgres psql -U polaris -d polaris -tAc 'SELECT count(*) FROM "User";' 2>$null)
        if ($userCount) { $userCount = $userCount.Trim() }
        if ($userCount -notmatch '^\d+$' -or [int]$userCount -eq 0) {
            $token = (Get-Content ".env" | Where-Object { $_ -match "^POLARIS_SETUP_TOKEN=" } | Select-Object -First 1) -replace "^POLARIS_SETUP_TOKEN=", ""
            Write-Host "polaris: First run - open this link to create the administrator:" -ForegroundColor Yellow
            Write-Host "polaris:   $openUrl/oauth/setup?token=$token" -ForegroundColor Yellow
            Write-Host "polaris: (registration is otherwise invite-only)" -ForegroundColor Yellow
        }
        Write-Log "check status with: polaris status"
    }
    finally {
        Pop-Location
    }
}

Invoke-PolarisInstall
