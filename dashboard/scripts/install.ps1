# Polaris dashboard one-command installer AND updater (Windows PowerShell). Run
# the same line to set up or to update: it pulls the latest source, adds any new
# settings to .env automatically, rebuilds, and restarts (applying migrations).
#
#   irm https://raw.githubusercontent.com/FJRG2007/polaris/main/dashboard/scripts/install.ps1 | iex
#   # full edition: set the flag first, then run the same line
#   $env:POLARIS_FULL = "1"; irm .../install.ps1 | iex
#
# Idempotent and non-destructive: never overwrites an existing .env. All logic
# lives in a function that returns (never `exit`) so piping into `iex` cannot
# close the caller's session.

function Invoke-PolarisInstall {
    [CmdletBinding()]
    param(
        [switch]$Full
    )

    $ErrorActionPreference = "Stop"
    $repoUrl = if ($env:POLARIS_REPO_URL) { $env:POLARIS_REPO_URL } else { "https://github.com/FJRG2007/polaris.git" }
    $installDir = if ($env:POLARIS_INSTALL_DIR) { $env:POLARIS_INSTALL_DIR } else { Join-Path $HOME "polaris" }

    # Env flag lets `irm | iex` opt into the full edition without arguments.
    if ($env:POLARIS_FULL -and $env:POLARIS_FULL -notin @("0", "false", "no", "")) {
        $Full = $true
    }

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
    function New-Secret {
        param([int]$Bytes = 32, [switch]$Hex)
        $buffer = New-Object 'System.Byte[]' $Bytes
        [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
        if ($Hex) {
            return -join ($buffer | ForEach-Object { $_.ToString("x2") })
        }
        return [System.Convert]::ToBase64String($buffer)
    }

    # Turn a known secret placeholder into a fresh value, or pass it through.
    function Get-Materialized {
        param($Value)
        switch ($Value) {
            "REPLACE_ME_openssl_rand_base64_32" { return (New-Secret -Bytes 32) }
            "REPLACE_ME_long_random_string" { return (New-Secret -Bytes 48) }
            "REPLACE_ME_setup_token" { return (New-Secret -Bytes 24 -Hex) }
            "REPLACE_ME_strong_password" { return (New-Secret -Bytes 24 -Hex) }
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
                $value = Get-Materialized $Matches[2]
                Add-Content -Path ".env" -Value "$key=$value"
                $added += $key
            }
        }
        if ($added.Count -gt 0) { Write-Log ("added new settings to .env: " + ($added -join ", ")) }
    }

    # Map polaris / polaris.local to loopback on this machine so they resolve even
    # without mDNS. Best effort and idempotent; editing hosts needs Administrator.
    function Set-PolarisHostnames {
        $hostsPath = Join-Path $env:SystemRoot "System32\drivers\etc\hosts"
        $marker = "# polaris-dashboard"
        try {
            if (Select-String -Path $hostsPath -SimpleMatch $marker -ErrorAction SilentlyContinue) { return }
            Add-Content -Path $hostsPath -Value "127.0.0.1 polaris polaris.local $marker" -ErrorAction Stop
            Write-Log "mapped polaris and polaris.local to 127.0.0.1 in hosts"
        }
        catch {
            Write-Host "polaris: could not edit hosts (run as Administrator to enable 'polaris'/'polaris.local'); add manually: 127.0.0.1 polaris polaris.local" -ForegroundColor Yellow
        }
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

    Push-Location $workdir
    try {
        if (-not (Test-Path ".env")) {
            Write-Log "generating .env with fresh secrets"
            $masterKey = New-Secret -Bytes 32
            $authSecret = New-Secret -Bytes 48
            $pgPassword = New-Secret -Bytes 24 -Hex
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

        Set-PolarisHostnames

        if ($Full) {
            Write-Log "enabling the full edition (privileged host daemon)"
            $env:COMPOSE_PROFILES = "full"
        }

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

        Write-Log "done. Polaris is running at: $appUrl"

        # Only advertise the first-run setup link while setup is still pending.
        $userCount = (docker compose exec -T postgres psql -U polaris -d polaris -tAc 'SELECT count(*) FROM "User";' 2>$null)
        if ($userCount) { $userCount = $userCount.Trim() }
        if ($userCount -notmatch '^\d+$' -or [int]$userCount -eq 0) {
            $token = (Get-Content ".env" | Where-Object { $_ -match "^POLARIS_SETUP_TOKEN=" } | Select-Object -First 1) -replace "^POLARIS_SETUP_TOKEN=", ""
            Write-Host "polaris: First run - open this link to create the administrator:" -ForegroundColor Yellow
            Write-Host "polaris:   http://polaris.local/oauth/setup?token=$token" -ForegroundColor Yellow
            Write-Host "polaris: (registration is otherwise invite-only)" -ForegroundColor Yellow
        }
        Write-Log "check status with: polaris status"
    }
    finally {
        Pop-Location
    }
}

Invoke-PolarisInstall @args
