# Polaris dashboard one-command installer (Windows PowerShell).
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

            $content = Get-Content ".env.example" -Raw
            $content = $content.Replace("REPLACE_ME_openssl_rand_base64_32", $masterKey)
            $content = $content.Replace("REPLACE_ME_long_random_string", $authSecret)
            $content = $content.Replace("REPLACE_ME_strong_password", $pgPassword)
            # Write UTF-8 without BOM so Docker reads the env_file cleanly.
            [System.IO.File]::WriteAllText((Join-Path (Get-Location) ".env"), $content)
            Write-Host "polaris: review .env and set POLARIS_SITE_ADDRESS / POLARIS_APP_URL to your domain" -ForegroundColor Yellow
        }
        else {
            Write-Log ".env already present, keeping it"
        }

        if ($Full) {
            Write-Log "enabling the full edition (privileged host daemon)"
            $env:COMPOSE_PROFILES = "full"
        }

        Write-Log "pulling images (falling back to a local build)"
        docker compose pull
        if ($LASTEXITCODE -ne 0) { docker compose build }

        Write-Log "starting the stack"
        docker compose up -d

        $appUrl = (Get-Content ".env" | Where-Object { $_ -match "^POLARIS_APP_URL=" } | Select-Object -First 1) -replace "^POLARIS_APP_URL=", ""
        if (-not $appUrl) { $appUrl = "your configured POLARIS_APP_URL" }
        Write-Log "done. Polaris should be reachable at: $appUrl"
        Write-Log "check status with: docker compose ps (from $(Get-Location))"
    }
    finally {
        Pop-Location
    }
}

Invoke-PolarisInstall @args
