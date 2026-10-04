# Polaris CLI installer for Windows (Windows PowerShell 5.1 or PowerShell 7).
# Each Polaris serves this at /cli/install.ps1 with its own address filled in
# below, so the line on its Account > Downloads screen installs the CLI that
# matches that server:
#
#   irm https://your-polaris/cli/install.ps1 | iex
#
# It puts the bundle and two launchers, plr.cmd and polaris.cmd, in
# %LOCALAPPDATA%\Programs\polaris-cli and adds that folder to your user PATH.
# Nothing needs Administrator. Running it again updates in place.
#
# It refuses to install on a computer that runs a Polaris SERVER: the server
# puts its own polaris and plr commands on PATH, and the two would collide.
#
# All logic lives in a function that returns rather than exits, so piping into
# `iex` cannot close the caller's window.

function Install-PolarisCli {
    [CmdletBinding()]
    param()

    $ErrorActionPreference = "Stop"
    $url = if ($env:POLARIS_URL) { $env:POLARIS_URL } else { "__POLARIS_URL__" }
    # Written into every file this installs, so `plr uninstall` and the server's
    # installer can tell them apart from anything else called polaris.
    $marker = "polaris-developer-cli"

    function Write-Log { param($Message) Write-Host "polaris-cli: $Message" }
    function Write-Problem { param($Message) Write-Host "polaris-cli: $Message" -ForegroundColor Red }

    if ($url -notmatch '^https?://') {
        Write-Problem "this script does not know which Polaris it came from."
        Write-Problem "copy the install line from Account > Downloads on your Polaris instead."
        return
    }

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Write-Problem "the CLI runs on Node.js 20 or newer, and node is not installed: https://nodejs.org"
        return
    }
    $major = [int](((& node -p "process.versions.node") -split '\.')[0])
    if ($major -lt 20) {
        Write-Problem "the CLI needs Node.js 20 or newer; this computer has $(& node --version). Update it: https://nodejs.org"
        return
    }

    # What a Polaris server install leaves on a machine. Mirrors
    # packages/cli/src/guard.ts, plus a look at Docker for the running stack.
    $found = $null
    $serverScript = Join-Path $env:LOCALAPPDATA "Polaris\bin\polaris.ps1"
    $checkout = if ($env:POLARIS_INSTALL_DIR) { $env:POLARIS_INSTALL_DIR } else { Join-Path $env:ProgramData "Polaris" }
    if ((Test-Path $serverScript) -and (Select-String -Path $serverScript -SimpleMatch "manage a Polaris dashboard deployment" -Quiet)) {
        $found = "the server's own command at $serverScript"
    }
    elseif (Test-Path (Join-Path $checkout "dashboard\docker\docker-compose.yml")) {
        $found = "a server checkout at $checkout"
    }
    elseif (Test-Path (Join-Path $env:ProgramData "Polaris\secrets.env")) {
        $found = "the server's secrets store in $(Join-Path $env:ProgramData 'Polaris')"
    }
    elseif (Get-Command docker -ErrorAction SilentlyContinue) {
        # Native stderr becomes a terminating error under Stop; Docker Desktop
        # not running is an ordinary answer here, not a failure.
        $saved = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try { $running = & docker ps -a -q --filter "label=com.docker.compose.project=polaris" 2>$null } catch { $running = $null }
        $ErrorActionPreference = $saved
        if ($running) { $found = "containers of the 'polaris' Docker Compose project" }
    }
    if ($found) {
        Write-Problem "this computer runs a Polaris server ($found)."
        Write-Problem "the server has its own polaris and plr commands, and the CLI would collide with them,"
        Write-Problem "so it is not installed here. Use the CLI from another computer."
        return
    }

    $dir = Join-Path $env:LOCALAPPDATA "Programs\polaris-cli"
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

    # Windows PowerShell 5.1 still offers TLS 1.0 first.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $tmp = Join-Path $dir ("polaris.mjs." + [Guid]::NewGuid().ToString("N"))
    Write-Log "downloading the CLI from $url"
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "$url/cli/polaris.mjs" -OutFile $tmp -PassThru
    }
    catch {
        Write-Problem "could not download it from $url/cli/polaris.mjs. Check that this computer can open $url."
        if (Test-Path $tmp) { Remove-Item -Force $tmp }
        return
    }

    # Checked against the digest the server sent with it, so a truncated or
    # rewritten download is never installed.
    $expected = [string]$response.Headers["x-content-sha256"]
    $actual = (Get-FileHash -Algorithm SHA256 -Path $tmp).Hash.ToLowerInvariant()
    if (-not $expected -or $expected.Trim().ToLowerInvariant() -ne $actual) {
        Remove-Item -Force $tmp
        Write-Problem "the download did not match its checksum; nothing was installed. Try again."
        return
    }
    Move-Item -Force -Path $tmp -Destination (Join-Path $dir "polaris.mjs")

    $installed = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    $json = "{`n    `"marker`": `"$marker`",`n    `"origin`": `"$url`",`n    `"sha256`": `"$actual`",`n    `"installedAt`": `"$installed`"`n}`n"
    [System.IO.File]::WriteAllText((Join-Path $dir "polaris-cli.json"), $json)

    # `(goto) 2>nul` ends the batch file's own context before node runs, so cmd
    # never goes back to read a launcher that `plr uninstall` has just deleted
    # ("The system cannot find the path specified"). Node's exit code still
    # comes through.
    $shim = "@echo off`r`nrem ${marker}: launcher for the Polaris CLI`r`n(goto) 2>nul & node `"%~dp0polaris.mjs`" %*`r`n"
    [System.IO.File]::WriteAllText((Join-Path $dir "plr.cmd"), $shim)
    [System.IO.File]::WriteAllText((Join-Path $dir "polaris.cmd"), $shim)

    # On PATH for future sessions, through the registry so an expandable user
    # PATH (the Windows default) stays expandable - the same way the server's
    # installer does it.
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
    try {
        $userPath = ""
        $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
        if ($key) {
            $userPath = [string]$key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            if ($key.GetValueNames() -contains "Path") { $kind = $key.GetValueKind("Path") }
        }
        if (($userPath -split ";") -notcontains $dir) {
            $updated = if ($userPath) { "$userPath;$dir" } else { $dir }
            if ($key) { $key.SetValue("Path", $updated, $kind) }
            else { [Environment]::SetEnvironmentVariable("Path", $updated, "User") }
            Write-Log "added $dir to your PATH; open a new terminal to use plr."
        }
    }
    finally { if ($key) { $key.Close() } }
    if (($env:Path -split ";") -notcontains $dir) { $env:Path = "$env:Path;$dir" }

    Write-Log "installed plr (also polaris)."
    Write-Log "next: plr login --url $url"
}

Install-PolarisCli
