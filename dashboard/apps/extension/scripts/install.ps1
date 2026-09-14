# Polaris browser extension: install AND update, for Chrome, Edge, Brave and
# Opera on Windows. Run the same line either way.
#
#   irm https://raw.githubusercontent.com/FJRG2007/polaris/main/dashboard/apps/extension/scripts/install.ps1 | iex
#
# What it does, and why it is worth a script at all: it puts the extension in ONE
# fixed folder and replaces what is there. An unpacked extension is re-read from
# the folder it was loaded from, so once the browser has been pointed at that
# folder every later version is the refresh arrow on the extensions page and
# nothing else - no second "Load unpacked", no second copy, no folder per
# version.
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
    param()

    $ErrorActionPreference = "Stop"
    $repo = if ($env:POLARIS_REPO) { $env:POLARIS_REPO } else { "FJRG2007/polaris" }

    # One fixed home, under this user's own application data. Override with
    # POLARIS_EXTENSION_DIR - but keep it the same folder every time, which is
    # the point of it.
    $dir = if ($env:POLARIS_EXTENSION_DIR) {
        $env:POLARIS_EXTENSION_DIR
    } else {
        Join-Path $env:LOCALAPPDATA "Polaris\extension\chrome"
    }

    function Write-Log { param($Message) Write-Host "polaris: $Message" }

    # The newest EXTENSION release, which is not the newest release. This
    # repository publishes the dashboard too and marks those as latest, so
    # `releases/latest` answers with a dashboard build carrying no extension.
    $agent = @{ "User-Agent" = "polaris-extension-installer" }
    $tag = $env:POLARIS_EXTENSION_TAG
    if (-not $tag) {
        $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases?per_page=100" -Headers $agent
        $tag = ($releases | Where-Object { $_.tag_name -like "extension-v*" } | Select-Object -First 1).tag_name
    }
    if (-not $tag) {
        Write-Error "No extension release has been published yet."
        return
    }

    # The package is asked for rather than spelled out. Published releases do not
    # agree on a filename: `wxt zip` used to name its output after the package and
    # the version - polarisextension-0.1.0-chrome.zip - and the config now pins one
    # stable name per browser. Both kinds are installable, since
    # POLARIS_EXTENSION_TAG is how somebody pins an older release, so a name
    # written here is right for some of them and a 404 half way through an install
    # for the rest. "chrome" identifies it: the other two packages on the release
    # are the Firefox build and the sources archive, and neither carries that word.
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/tags/$tag" -Headers $agent
    $asset = $release.assets | Where-Object { $_.name -like "*chrome*.zip" } | Select-Object -First 1
    if (-not $asset) {
        Write-Error "Release $tag carries no Chromium package."
        return
    }
    $url = $asset.browser_download_url
    # Downloaded and unpacked away from the live folder, so a failure half way
    # leaves the copy the browser is loading exactly as it was.
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("polaris-extension-" + [System.Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null

    try {
        Write-Log "fetching $tag"
        $zip = Join-Path $tmp "extension.zip"
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
        $unpacked = Join-Path $tmp "unpacked"
        Expand-Archive -Path $zip -DestinationPath $unpacked -Force

        $parent = Split-Path -Parent $dir
        if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
        Move-Item -Path $unpacked -Destination $dir

        Write-Log "installed in $dir"
        Write-Log ""
        Write-Log "First time: open chrome://extensions (brave://, edge:// or opera:// in"
        Write-Log "those), turn on Developer mode, press Load unpacked and choose:"
        Write-Log "  $dir"
        Write-Log ""
        Write-Log "Every time after: run this again, then press the refresh arrow on the"
        Write-Log "Polaris card. The folder does not change, so nothing else has to."
    }
    finally {
        if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
    }
}

Invoke-PolarisExtensionInstall
