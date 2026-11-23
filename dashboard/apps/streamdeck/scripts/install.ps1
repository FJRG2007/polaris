# Polaris for Stream Deck: install the plugin, and keep it up to date by itself,
# in the Stream Deck app on Windows.
#
#   irm https://raw.githubusercontent.com/FJRG2007/polaris/main/dashboard/apps/streamdeck/scripts/install.ps1 | iex
#
# And to stop the updates and remove it again:
#
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/FJRG2007/polaris/main/dashboard/apps/streamdeck/scripts/install.ps1))) uninstall
#
# What it does: it fetches the newest `streamdeck-v*` release of this
# repository and puts the plugin where the Stream Deck app keeps its plugins,
# %APPDATA%\Elgato\StreamDeck\Plugins\<uuid>.sdPlugin. A `.streamDeckPlugin`
# file is a zip holding that one folder, so installing it silently is
# unpacking it there. The app reads its plugins when it starts and holds the
# running plugin's folder open, so when the app is running it is closed for
# the swap and started again (in the background, as it starts at sign-in);
# when it is not running, nothing is started and it finds the plugin next
# time. If the folder cannot be swapped, the file is opened instead, which is
# the app's own install dialog.
#
# Then it leaves a scheduled task of this user's own (no administrator rights)
# that runs every hour, out of sight, and does the same when a newer
# release is out. What the task runs is a copy of THIS script as the release
# attached it, checked against the digest GitHub publishes for it.
#
# Running the line again is safe: it replaces the task rather than adding a
# second one, and leaves the plugin as it is when it is already current.
#
# All the logic lives in a function that RETURNS rather than calling exit, so
# piping this into `iex` cannot close the caller's session.

function Invoke-PolarisStreamDeckInstall {
    [CmdletBinding()]
    param(
        [string]$Mode = "install",
        # The task passes these back: a scheduled run starts with none of the
        # environment the install line ran with.
        [string]$Repo = "",
        [string]$Api = "",
        [string]$Plugins = ""
    )

    $ErrorActionPreference = "Stop"
    $ProgressPreference = "SilentlyContinue"
    $repo = if ($Repo) { $Repo } elseif ($env:POLARIS_REPO) { $env:POLARIS_REPO } else { "FJRG2007/polaris" }
    # Only ever changed to test this script against a stand-in.
    $api = if ($Api) { $Api } elseif ($env:POLARIS_GITHUB_API) { $env:POLARIS_GITHUB_API } else { "https://api.github.com" }
    $api = $api.TrimEnd("/")
    if ($Mode -notin @("install", "scheduled", "uninstall")) {
        Write-Host "polaris: '$Mode' is not something this script does. Run it with no argument to install, or with 'uninstall'."
        return
    }
    $scheduled = $Mode -eq "scheduled"

    # The plugin's identifier, which is also its folder's name (manifest.json `UUID`).
    $uuid = "io.github.fjrg2007.polaris"
    $appPlugins = Join-Path $env:APPDATA "Elgato\StreamDeck\Plugins"
    # POLARIS_STREAMDECK_PLUGINS installs somewhere else - only to try this
    # script out. The Stream Deck app is never closed or started for a folder
    # it does not read.
    $plugins = if ($Plugins) { $Plugins } elseif ($env:POLARIS_STREAMDECK_PLUGINS) { $env:POLARIS_STREAMDECK_PLUGINS } else { $appPlugins }
    $plugins = [System.IO.Path]::GetFullPath($plugins)
    $ownsApp = $plugins -eq [System.IO.Path]::GetFullPath($appPlugins)
    $dir = Join-Path $plugins "$uuid.sdPlugin"
    $base = Join-Path $env:LOCALAPPDATA "Polaris\streamdeck"
    $updater = Join-Path $base "update.ps1"
    $logFile = Join-Path $base "update.log"
    $taskName = "Polaris Stream Deck updates"
    # How often the task runs. Every six hours let a morning of releases wait
    # until the evening; once an hour is still far inside what GitHub lets one
    # address ask unsigned (60 an hour), at one request a run.
    $every = New-TimeSpan -Hours 1

    function Write-Log {
        param($Message)
        if ($scheduled) {
            $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
            try {
                if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 64KB) { Remove-Item $logFile -Force }
                Add-Content -Path $logFile -Value $line -Encoding UTF8
            } catch { }
        } else {
            Write-Host "polaris: $Message"
        }
    }

    function Get-App {
        if (-not $ownsApp) { return $null }
        return Get-Process -Name "StreamDeck" -ErrorAction SilentlyContinue | Select-Object -First 1
    }

    function Stop-App {
        # The app has no command to quit it, and Elgato's own guide to removing
        # a plugin is to close it completely first.
        param($Process)
        Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
        try { Wait-Process -Id $Process.Id -Timeout 20 -ErrorAction SilentlyContinue } catch { }
        # Its plugins are separate processes and go with it; give them a moment.
        Start-Sleep -Seconds 2
    }

    function Test-AppShown {
        # Whether its window was on screen, as opposed to sitting in the tray:
        # a window in the tray has no main window handle.
        param($Process)
        return $Process -and $Process.MainWindowHandle -ne [IntPtr]::Zero
    }

    function Start-App {
        # Back the way it was found: with its window if it had one open, to the
        # tray if that is where it was.
        param($Path, [bool]$Shown = $false)
        if ($Path -and (Test-Path $Path)) {
            if ($Shown) {
                Start-Process -FilePath $Path
            } else {
                # `--runinbk` is how the app starts itself at sign-in: to the tray.
                Start-Process -FilePath $Path -ArgumentList "--runinbk"
            }
        }
    }

    if ($Mode -eq "uninstall") {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        $running = Get-App
        $exe = if ($running) { $running.Path } else { $null }
        $shown = Test-AppShown $running
        if ($running -and (Test-Path $dir)) { Stop-App $running }
        foreach ($path in @($dir, $updater, $logFile)) {
            if (Test-Path $path) { Remove-Item -Recurse -Force $path -ErrorAction SilentlyContinue }
        }
        if ($running) { Start-App $exe $shown }
        Write-Log "removed the updates task and the plugin"
        return
    }

    if (-not (Test-Path $plugins)) {
        if ($ownsApp) {
            Write-Log "the Stream Deck app is not installed for this user. Install it from elgato.com, open it once, and run this again."
            return
        }
        New-Item -ItemType Directory -Path $plugins -Force | Out-Null
    }

    $agent = @{ "User-Agent" = "polaris-streamdeck-installer"; "Accept" = "application/vnd.github+json" }

    # The newest PLUGIN release, which is not the newest release: this
    # repository publishes the dashboard too and marks those as latest.
    # Asked twice: a list GitHub answers while a release is being published has
    # been seen to come back without any plugin release in it, and the line then
    # reported that none had ever been published. Each time a short page at a
    # time, newest first, up to the 100 newest: one page of 100 is over a
    # megabyte to download and parse, and the plugin is nearly always near the top.
    $release = $null
    foreach ($attempt in 1..2) {
        try {
            for ($page = 1; $page -le 4 -and -not $release; $page++) {
                # Kept before it is listed: Windows PowerShell hands the parsed array
                # on as ONE object, which @() around the call would wrap in another.
                $listed = Invoke-RestMethod -Uri "$api/repos/$repo/releases?per_page=25&page=$page" -Headers $agent
                $releases = @($listed)
                $release = $releases |
                    Where-Object { $_.tag_name -like "streamdeck-v*" -and -not $_.draft -and -not $_.prerelease } |
                    Select-Object -First 1
                if ($releases.Count -lt 25) { break }
            }
        } catch {
            if ($attempt -eq 2) {
                Write-Log "could not reach GitHub: $($_.Exception.Message)"
                return
            }
        }
        if ($release) { break }
        if ($attempt -eq 1) { Start-Sleep -Seconds 5 }
    }
    if (-not $release) {
        Write-Log "GitHub listed no Stream Deck plugin release just now. Run the line again in a minute."
        return
    }
    $tag = $release.tag_name
    $version = $tag -replace "^streamdeck-v", ""
    # The manifest's four-part version for a release `x.y.z`.
    $wanted = "$version.0"
    $asset = $release.assets | Where-Object { $_.name -like "*.streamDeckPlugin" } | Select-Object -First 1
    if (-not $asset) {
        Write-Log "release $tag carries no .streamDeckPlugin file"
        return
    }

    function Test-Digest {
        # GitHub publishes a sha256 for every asset it stores; a download that
        # does not match it is not installed. Assets uploaded before GitHub
        # computed digests carry none.
        param($File, $Expected)
        if (-not $Expected) { return $true }
        if ($Expected -notmatch "^sha256:([0-9a-fA-F]{64})$") { return $false }
        return (Get-FileHash -Algorithm SHA256 -Path $File).Hash -eq $Matches[1].ToUpperInvariant()
    }

    function Expand-PolarisZip {
        # .NET's own extraction rather than Expand-Archive: that cmdlet draws a
        # progress bar for every file whatever this function's
        # $ProgressPreference says, which took seconds for a few hundred files.
        # It refuses an entry that would land outside the folder, as
        # Expand-Archive does.
        param($Zip, $Destination)
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::ExtractToDirectory($Zip, $Destination)
    }

    function Get-InstalledVersion {
        $manifest = Join-Path $dir "manifest.json"
        if (-not (Test-Path $manifest)) { return $null }
        try { return (Get-Content -Raw -Path $manifest | ConvertFrom-Json).Version } catch { return $null }
    }

    if (-not (Test-Path $base)) { New-Item -ItemType Directory -Path $base -Force | Out-Null }

    if ((Get-InstalledVersion) -eq $wanted) {
        if (-not $scheduled) { Write-Log "$version is already installed" }
    } else {
        $stage = Join-Path $base (".incoming-" + [System.Guid]::NewGuid().ToString("N"))
        $retired = Join-Path $base (".retired-" + [System.Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $stage -Force | Out-Null
        try {
            Write-Log "fetching $tag"
            $file = Join-Path $stage $asset.name
            Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $file -UseBasicParsing -Headers @{ "User-Agent" = $agent["User-Agent"] }
            if (-not (Test-Digest $file $asset.digest)) {
                Write-Log "the download for $tag does not match its published digest; nothing was changed"
                return
            }
            # A .streamDeckPlugin file is a zip under another name.
            $unpacked = Join-Path $stage "unpacked"
            Expand-PolarisZip $file $unpacked
            $fresh = Join-Path $unpacked "$uuid.sdPlugin"
            $read = $null
            try { $read = Get-Content -Raw -Path (Join-Path $fresh "manifest.json") | ConvertFrom-Json } catch { }
            if (-not $read -or $read.UUID -ne $uuid -or $read.Version -ne $wanted) {
                Write-Log "the file in $tag is not the plugin it says it is; nothing was changed"
                return
            }

            $running = Get-App
            $exe = if ($running) { $running.Path } else { $null }
            $shown = Test-AppShown $running
            if ($running) {
                Write-Log "closing the Stream Deck app to put the new version in; it opens again as it was"
                Stop-App $running
            }
            $swapped = $false
            try {
                if (Test-Path $dir) { Move-Item -Path $dir -Destination $retired }
                try {
                    Move-Item -Path $fresh -Destination $dir
                    $swapped = $true
                } catch {
                    if (Test-Path $retired) { Move-Item -Path $retired -Destination $dir }
                    throw
                }
            } catch {
                Write-Log "could not put $version in place: $($_.Exception.Message)"
            } finally {
                if ($running) { Start-App $exe $shown }
            }

            if ($swapped) {
                Write-Log "installed $version"
            } elseif (-not $scheduled -and $ownsApp) {
                # The app's own install dialog, from the same file.
                $keep = Join-Path $base $asset.name
                Copy-Item -Path $file -Destination $keep -Force
                Start-Process -FilePath $keep
                Write-Log "opened the plugin file instead: confirm the install in the Stream Deck app"
            } else {
                return
            }
        } catch {
            Write-Log "could not install ${tag}: $($_.Exception.Message)"
            return
        } finally {
            foreach ($path in @($stage, $retired)) {
                if (Test-Path $path) { Remove-Item -Recurse -Force $path -ErrorAction SilentlyContinue }
            }
        }
    }

    # The updater the task runs: this script, exactly as the release attached
    # it, refreshed whenever the published one differs from the copy here.
    $script = $release.assets | Where-Object { $_.name -eq "install.ps1" } | Select-Object -First 1
    $same = $script -and $script.digest -and (Test-Path $updater) -and (Test-Digest $updater $script.digest)
    if ($script -and -not $same) {
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

    $updating = $false
    # Started through conhost's headless mode where there is one, so no
    # console window flashes every hour (the extension's script explains the
    # details).
    $powershell = Join-Path $PSHOME "powershell.exe"
    if (-not (Test-Path $powershell)) { $powershell = "powershell.exe" }
    $command = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" scheduled "{1}" "{2}" "{3}"' -f
        $updater, $repo, $api, $plugins
    $conhost = if ($env:SystemRoot) { Join-Path $env:SystemRoot "System32\conhost.exe" } else { "" }
    if ($conhost -and [System.Environment]::OSVersion.Version.Build -ge 17763 -and (Test-Path $conhost)) {
        $execute = $conhost
        $arguments = '--headless "{0}" {1}' -f $powershell, $command
    } else {
        $execute = $powershell
        $arguments = $command
    }

    # A person's run always (re)registers the task. A scheduled run leaves its
    # own task alone, except to bring one an older release registered (every
    # six hours) up to this release's schedule: nobody who installed it will
    # run the line again to get that. Only a task that runs THIS updater
    # counts, and a task the user deleted is not put back.
    $register = -not $scheduled
    if ($scheduled) {
        $held = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($held -and @($held.Actions | Where-Object { "$($_.Arguments)".Contains($updater) }).Count -gt 0) {
            $interval = [System.Xml.XmlConvert]::ToString($every)
            $slow = @($held.Triggers | Where-Object { $_.Repetition.Interval -ne $interval }).Count -gt 0
            $register = $slow -or $held.Actions.Count -ne 1 -or
                $held.Actions[0].Execute -ne $execute -or $held.Actions[0].Arguments -ne $arguments
        }
    }

    if ($register -and (Test-Path $updater)) {
        try {
            $user = "$env:USERDOMAIN\$env:USERNAME"
            $action = New-ScheduledTaskAction -Execute $execute -Argument $arguments
            $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(10) -RepetitionInterval $every
            $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
                -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew
            $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
            # -Force replaces a task of the same name: running the line twice leaves one.
            Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
                -Principal $principal -Description "Keeps Polaris for Stream Deck up to date." -Force | Out-Null
            if ($scheduled) { Write-Log "re-registered the updates task with this release's settings" }
            $updating = $true
        } catch {
            Write-Log "could not set up the updates task: $($_.Exception.Message)"
        }
    }

    if (-not $scheduled) {
        Write-Log ""
        if ($updating) {
            Write-Log "It checks for a new version every hour and installs it by itself."
        } else {
            Write-Log "To update it, run this line again."
        }
        Write-Log "Next: open the Stream Deck app, find Polaris in the actions list on the"
        Write-Log "right, drag an action onto a key and press Connect in its settings."
    }
}

# `scheduled` (with the repository, the API and the folder after it) is what the
# task passes; `uninstall` is the line at the top. Piped into `iex` there are no
# arguments, which is an install.
Invoke-PolarisStreamDeckInstall `
    -Mode $(if ($args.Count -gt 0) { [string]$args[0] } else { "install" }) `
    -Repo $(if ($args.Count -gt 1) { [string]$args[1] } else { "" }) `
    -Api $(if ($args.Count -gt 2) { [string]$args[2] } else { "" }) `
    -Plugins $(if ($args.Count -gt 3) { [string]$args[3] } else { "" })
