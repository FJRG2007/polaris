# Polaris browser extension: install it, and keep it up to date by itself, for
# Chrome, Edge, Brave and Opera on Windows.
#
#   irm https://raw.githubusercontent.com/FJRG2007/polaris/main/dashboard/apps/extension/scripts/install.ps1 | iex
#
# And to stop the updates and remove it again:
#
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/FJRG2007/polaris/main/dashboard/apps/extension/scripts/install.ps1))) uninstall
#
# What it does, and why it is worth a script at all: it puts the extension in ONE
# fixed folder. An unpacked extension is re-read from the folder it was loaded
# from, so once the browser has been pointed at that folder a newer version is
# only ever new files in the same place - and the extension notices its own
# files changed and restarts into them (`src/lib/self-update.ts`).
#
# So the script also leaves behind the one thing that puts new files there: a
# scheduled task of this user's own (no administrator rights, nothing for anybody
# else on the machine) that runs a few times a day and at sign-in, asks GitHub
# for the newest extension release, and swaps the folder when there is one.
# What the task runs is a copy of THIS script as the release attached it,
# checked against the digest GitHub publishes for it and refreshed with every
# update, so the updater is always the one the installed version shipped with.
#
# Running the line again is safe: it replaces the task rather than adding a
# second one, and leaves the extension as it is when it is already current.
#
# Firefox is deliberately not handled. A temporary add-on is loaded through
# about:debugging and is gone when Firefox closes, so there is nothing on disk
# for a script to keep current.
#
# All the logic lives in a function that RETURNS rather than calling exit, so
# piping this into `iex` cannot close the caller's session - the same shape the
# dashboard's own installer uses.

function Invoke-PolarisExtensionInstall {
    [CmdletBinding()]
    param(
        [string]$Mode = "install",
        # The task passes these back, because nothing else would: a scheduled
        # run starts with none of the environment the install line ran with.
        [string]$Dir = "",
        [string]$Repo = "",
        [string]$Api = ""
    )

    $ErrorActionPreference = "Stop"
    $ProgressPreference = "SilentlyContinue"
    $repo = if ($Repo) { $Repo } elseif ($env:POLARIS_REPO) { $env:POLARIS_REPO } else { "FJRG2007/polaris" }
    # Where GitHub's API is. Only ever changed to test this script against a
    # stand-in; the task carries it so a scheduled run asks the same place.
    $api = if ($Api) { $Api } elseif ($env:POLARIS_GITHUB_API) { $env:POLARIS_GITHUB_API } else { "https://api.github.com" }
    $api = $api.TrimEnd("/")
    if ($Mode -notin @("install", "scheduled", "uninstall")) {
        Write-Host "polaris: '$Mode' is not something this script does. Run it with no argument to install, or with 'uninstall'."
        return
    }
    $scheduled = $Mode -eq "scheduled"
    $updating = $false

    # One fixed home, under this user's own application data. Override with
    # POLARIS_EXTENSION_DIR - but keep it the same folder every time, which is
    # the point of it. The updater and its log live one level up, beside it
    # rather than inside it: the folder itself is replaced whole on every update.
    $taskName = "Polaris extension updates"
    if (-not $Dir -and -not $env:POLARIS_EXTENSION_DIR -and $Mode -eq "uninstall") {
        # Removing an install made into another folder: the task knows which.
        $held = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($held -and $held.Actions[0].Arguments -match 'scheduled "([^"]+)"') { $Dir = $Matches[1] }
    }
    $dir = if ($Dir) {
        $Dir
    } elseif ($env:POLARIS_EXTENSION_DIR) {
        $env:POLARIS_EXTENSION_DIR
    } else {
        Join-Path $env:LOCALAPPDATA "Polaris\extension\chrome"
    }
    $dir = [System.IO.Path]::GetFullPath($dir)
    $base = Split-Path -Parent $dir
    $updater = Join-Path $base "update.ps1"
    $logFile = Join-Path $base "update.log"
    # Written into the extension's own folder, so the extension can read it and
    # know that this copy is kept current by the task rather than by hand.
    $marker = "polaris-updater.json"

    function Write-Log {
        param($Message)
        if ($scheduled) {
            # Nobody is watching a scheduled run, so it keeps a short log instead.
            $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
            try {
                if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 64KB) { Remove-Item $logFile -Force }
                Add-Content -Path $logFile -Value $line -Encoding UTF8
            } catch { }
        } else {
            Write-Host "polaris: $Message"
        }
    }

    if ($Mode -eq "uninstall") {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        foreach ($path in @($dir, $updater, $logFile)) {
            if (Test-Path $path) { Remove-Item -Recurse -Force $path -ErrorAction SilentlyContinue }
        }
        Write-Log "removed the updates task and $dir"
        Write-Log "Remove the Polaris card on your browser's extensions page as well."
        return
    }

    $agent = @{ "User-Agent" = "polaris-extension-installer"; "Accept" = "application/vnd.github+json" }

    # The newest EXTENSION release, which is not the newest release. This
    # repository publishes the dashboard too and marks those as latest, so
    # `releases/latest` answers with a dashboard build carrying no extension.
    # POLARIS_EXTENSION_TAG pins one instead, and a pinned install is left
    # without the task: somebody who asked for that version asked to stay on it.
    $pinned = [bool]$env:POLARIS_EXTENSION_TAG
    try {
        if ($pinned) {
            $release = Invoke-RestMethod -Uri "$api/repos/$repo/releases/tags/$($env:POLARIS_EXTENSION_TAG)" -Headers $agent
        } else {
            $releases = Invoke-RestMethod -Uri "$api/repos/$repo/releases?per_page=100" -Headers $agent
            $release = $releases |
                Where-Object { $_.tag_name -like "extension-v*" -and -not $_.draft -and -not $_.prerelease } |
                Select-Object -First 1
        }
    } catch {
        Write-Log "could not reach GitHub: $($_.Exception.Message)"
        return
    }
    if (-not $release) {
        Write-Log "no extension release has been published yet"
        return
    }
    $tag = $release.tag_name
    $version = $tag -replace "^extension-v", ""

    # The package is asked for rather than spelled out: published releases do not
    # agree on a filename, and "chrome" is the one word that tells it apart from
    # the Firefox build and the sources archive.
    $asset = $release.assets | Where-Object { $_.name -like "*chrome*.zip" } | Select-Object -First 1
    if (-not $asset) {
        Write-Log "release $tag carries no Chromium package"
        return
    }

    function Test-Digest {
        # GitHub publishes a sha256 for every asset it stores. A download that
        # does not match it is not installed, whatever else it looks like.
        # Releases uploaded before GitHub computed digests carry none, and those
        # are accepted on the other checks alone.
        param($File, $Expected)
        if (-not $Expected) { return $true }
        if ($Expected -notmatch "^sha256:([0-9a-fA-F]{64})$") { return $false }
        return (Get-FileHash -Algorithm SHA256 -Path $File).Hash -eq $Matches[1].ToUpperInvariant()
    }

    function Get-InstalledVersion {
        $manifest = Join-Path $dir "manifest.json"
        if (-not (Test-Path $manifest)) { return $null }
        try { return (Get-Content -Raw -Path $manifest | ConvertFrom-Json).version } catch { return $null }
    }

    $installed = Get-InstalledVersion
    $current = $installed -eq $version -and (Test-Path (Join-Path $dir $marker))

    if (-not (Test-Path $base)) { New-Item -ItemType Directory -Path $base -Force | Out-Null }

    if (-not $current) {
        # Downloaded, unpacked and checked BESIDE the live folder, on the same
        # volume, so the swap at the end is two renames and a failure anywhere
        # before it leaves the copy the browser is loading exactly as it was.
        $stage = Join-Path $base (".incoming-" + [System.Guid]::NewGuid().ToString("N"))
        $retired = Join-Path $base (".retired-" + [System.Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $stage -Force | Out-Null
        try {
            Write-Log "fetching $tag"
            $zip = Join-Path $stage "extension.zip"
            Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing -Headers @{ "User-Agent" = $agent["User-Agent"] }
            if (-not (Test-Digest $zip $asset.digest)) {
                Write-Log "the download for $tag does not match its published digest; nothing was changed"
                return
            }
            $unpacked = Join-Path $stage "unpacked"
            Expand-Archive -Path $zip -DestinationPath $unpacked -Force
            $manifest = Join-Path $unpacked "manifest.json"
            $read = $null
            try { $read = Get-Content -Raw -Path $manifest | ConvertFrom-Json } catch { }
            if (-not $read -or $read.version -ne $version -or -not $read.background) {
                Write-Log "the package for $tag is not the extension it says it is; nothing was changed"
                return
            }
            $note = [ordered]@{ updater = "windows-task"; tag = $tag; updatedAt = (Get-Date).ToUniversalTime().ToString("o") }
            if ($pinned) { $note.updater = "none" }
            Set-Content -Path (Join-Path $unpacked $marker) -Value ($note | ConvertTo-Json -Compress) -Encoding UTF8

            # The swap. The live folder is renamed away and the new one renamed
            # in; if the second rename fails the first is undone.
            if (Test-Path $dir) { Move-Item -Path $dir -Destination $retired }
            try {
                Move-Item -Path $unpacked -Destination $dir
            } catch {
                if (Test-Path $retired) { Move-Item -Path $retired -Destination $dir }
                throw
            }
            Write-Log "installed $version in $dir"
        } catch {
            Write-Log "could not install ${tag}: $($_.Exception.Message)"
            return
        } finally {
            foreach ($path in @($stage, $retired)) {
                if (Test-Path $path) { Remove-Item -Recurse -Force $path -ErrorAction SilentlyContinue }
            }
        }
    } elseif (-not $scheduled) {
        Write-Log "$version is already installed in $dir"
    }

    if ($pinned) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        if (-not $scheduled) { Write-Log "pinned to $tag, so it will not update itself" }
    } else {
        # The updater the task runs: this script, exactly as the release
        # attached it. Refreshed on every run, so a release that changes how
        # updating works is followed by the task too.
        $script = $release.assets | Where-Object { $_.name -eq "install.ps1" } | Select-Object -First 1
        if ($script) {
            $fresh = Join-Path $base ("update-" + [System.Guid]::NewGuid().ToString("N") + ".ps1")
            try {
                Invoke-WebRequest -Uri $script.browser_download_url -OutFile $fresh -UseBasicParsing -Headers @{ "User-Agent" = $agent["User-Agent"] }
                if (Test-Digest $fresh $script.digest) {
                    Move-Item -Path $fresh -Destination $updater -Force
                } else {
                    Write-Log "the updater attached to $tag does not match its published digest; keeping the one there was"
                }
            } catch {
                Write-Log "could not fetch the updater: $($_.Exception.Message)"
            } finally {
                if (Test-Path $fresh) { Remove-Item -Force $fresh -ErrorAction SilentlyContinue }
            }
        }

        # Registered by a person's run only; a scheduled run leaves its own task
        # alone. -Force replaces a task of the same name, which is what makes
        # running the line twice leave one task rather than two.
        if (-not $scheduled -and (Test-Path $updater)) {
            try {
                $user = "$env:USERDOMAIN\$env:USERNAME"
                $powershell = Join-Path $PSHOME "powershell.exe"
                if (-not (Test-Path $powershell)) { $powershell = "powershell.exe" }
                $action = New-ScheduledTaskAction -Execute $powershell -Argument (
                    ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" scheduled "{1}" "{2}" "{3}"' -f
                        $updater, $dir, $repo, $api)
                )
                $triggers = @(
                    (New-ScheduledTaskTrigger -AtLogOn -User $user),
                    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(10) -RepetitionInterval (New-TimeSpan -Hours 6))
                )
                $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
                    -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew
                $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
                Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Settings $settings `
                    -Principal $principal -Description "Keeps the Polaris browser extension in $dir up to date." -Force | Out-Null
                Write-Log "it updates itself: every 6 hours and when you sign in to Windows"
                $updating = $true
            } catch {
                Write-Log "could not set up the updates task: $($_.Exception.Message)"
            }
        }
    }

    # The note in the folder says a task keeps it current. Where none could be
    # set up it says so, and the extension keeps showing the manual steps.
    $notePath = Join-Path $dir $marker
    if (-not $scheduled -and -not $updating -and (Test-Path $notePath)) {
        try {
            $held = Get-Content -Raw -Path $notePath | ConvertFrom-Json
            $held.updater = "none"
            Set-Content -Path $notePath -Value ($held | ConvertTo-Json -Compress) -Encoding UTF8
        } catch { }
    }

    if (-not $scheduled) {
        Write-Log ""
        Write-Log "First time: open chrome://extensions (brave://, edge:// or opera:// in"
        Write-Log "those), turn on Developer mode, press Load unpacked and choose:"
        Write-Log "  $dir"
        Write-Log ""
        if ($updating) {
            Write-Log "That is the only time. New versions arrive in that folder by themselves"
            Write-Log "and the extension restarts into them."
        } else {
            Write-Log "To update it, run this line again and press the refresh arrow on the"
            Write-Log "Polaris card."
        }
    }
}

# `scheduled` (with the folder, the repository and the API after it) is what the
# task passes; `uninstall` is the line at the top. Piped into `iex` there are no
# arguments, which is an install.
Invoke-PolarisExtensionInstall `
    -Mode $(if ($args.Count -gt 0) { [string]$args[0] } else { "install" }) `
    -Dir $(if ($args.Count -gt 1) { [string]$args[1] } else { "" }) `
    -Repo $(if ($args.Count -gt 2) { [string]$args[2] } else { "" }) `
    -Api $(if ($args.Count -gt 3) { [string]$args[3] } else { "" })
