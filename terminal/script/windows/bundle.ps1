#!/usr/bin/env powershell
#
# Bundle the application for release.

Param (
    # Build dev bundles by default.
    [Switch]$DEBUG_BUILD = $False,

    [Alias('check-only')]
    [Switch]$CHECK_ONLY,
    [ValidateSet('app', 'tui', 'cli')]
    [String]$ARTIFACT = 'app',

    [ValidateSet('local', 'dev', 'preview', 'stable', 'oss')]
    [String]$CHANNEL = 'dev',

    [Alias('release-tag')]
    [String]$RELEASE_TAG = '',
    [String]$FEATURES = 'release_bundle,crash_reporting,gui',

    # Builds only the Rook binary, skips the installer.
    [Switch]$SKIP_BUILD_INSTALLER = $False,
    # Builds only the installer, skips the Rook binary. Use this if the Rook
    # binary has already been built.
    [Switch]$SKIP_BUILD_BINARY = $False,

    [ValidateSet('x64', 'arm64')]
    [String]$ARCH = '',
    [Switch]$REQUIRE_SIGNATURES = $False,

    # A signtool command for Inno Setup to sign the setup engine and uninstaller.
    # Uses $f as the file placeholder, e.g.:
    #   'signtool.exe sign /fd SHA256 ... $f'
    # When empty, the installer is built without signing.
    [Alias('sign-tool-cmd')]
    [String]$SIGN_TOOL_CMD = ''
)

if ($RELEASE_TAG) {
    $env:GIT_RELEASE_TAG = $RELEASE_TAG
}

# Use provided ARCH parameter if set, otherwise detect from system
if (-not $ARCH) {
    if ($env:PROCESSOR_ARCHITECTURE -eq 'AMD64') {
        $ARCH = 'x64'
    } elseif ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
        $ARCH = 'arm64'
    } else {
        throw "Unsupported processor architecture: $env:PROCESSOR_ARCHITECTURE"
    }
}

if ($ARCH -eq 'arm64') {
    $FILE_ENDING = 'Setup-arm64'
    $PLATFORM_TARGET = 'aarch64-pc-windows-msvc'
} else {
    # If x64, then we just use the filename "RookSetup.exe" for example
    $FILE_ENDING = 'Setup'
    $PLATFORM_TARGET = 'x86_64-pc-windows-msvc'
}

# Windows-on-ARM64 hosts can run x64 binaries via built-in emulation, but x64
# hosts cannot run arm64 binaries at all, so only that direction is unsafe.
# Resolve it once so the settings-schema default below (which assumes the
# just-built binary is executable) can fail clearly instead of the process
# simply failing to start.
#
# PROCESSOR_ARCHITECTURE reports the architecture of the running process, not
# the host: an x64 PowerShell process running under WOW64 on a Windows-on-ARM
# machine reports AMD64 even though the host is natively ARM64.
# PROCESSOR_ARCHITEW6432 carries the true native host architecture in that
# case, so prefer it when present.
$NATIVE_PROCESSOR_ARCHITECTURE = if ($env:PROCESSOR_ARCHITEW6432) {
    $env:PROCESSOR_ARCHITEW6432
} else {
    $env:PROCESSOR_ARCHITECTURE
}
$HOST_ARCH = if ($NATIVE_PROCESSOR_ARCHITECTURE -eq 'AMD64') {
    'x64'
} elseif ($NATIVE_PROCESSOR_ARCHITECTURE -eq 'ARM64') {
    'arm64'
} else {
    throw "Unsupported host architecture: $NATIVE_PROCESSOR_ARCHITECTURE"
}
$CAN_EXECUTE_ARCH = -not ($ARCH -eq 'arm64' -and $HOST_ARCH -eq 'x64')

$ErrorActionPreference = 'Stop'

function Assert-ValidSignature {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute(
        'PSUseCompatibleCommands',
        '',
        Justification = 'Release signature validation only runs on Windows.'
    )]
    param([string] $Path)

    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ("$($signature.Status)" -ne 'Valid') {
        throw "File does not have a valid Authenticode signature: $Path ($($signature.Status))"
    }
}

$WORKSPACE_ROOT_DIR = $PWD.Path
$CARGO_TARGET_DIR = $WORKSPACE_ROOT_DIR + '\target'
$WINDOWS_INSTALLER_DIR = $WORKSPACE_ROOT_DIR + '\script\windows'
$IS_TUI = $ARTIFACT -eq 'tui'
$IS_CLI = $ARTIFACT -eq 'cli'

if ($DEBUG_BUILD) {
    $CARGO_PROFILE = 'dev'
} elseif (($IS_TUI -or $IS_CLI) -and (("$CHANNEL" -eq 'local') -or ("$CHANNEL" -eq 'dev'))) {
    $CARGO_PROFILE = 'rclida'
} elseif ($IS_TUI -or $IS_CLI) {
    $CARGO_PROFILE = 'rcli'
} elseif (("$CHANNEL" -eq 'local') -or ("$CHANNEL" -eq 'dev')) {
    # For dev bundles, we want to enable debug assertions to
    # catch violations that would otherwise silently pass in
    # a normal release build (e.g. in stable).
    $CARGO_PROFILE = 'rltoda'
} else {
    $CARGO_PROFILE = 'rlto'
}

if ($CARGO_PROFILE -eq 'dev') {
    $CARGO_TARGET_OUTPUT_DIR = "$CARGO_TARGET_DIR" + '\' + $PLATFORM_TARGET + '\debug'
} else {
    $CARGO_TARGET_OUTPUT_DIR = "$CARGO_TARGET_DIR" + '\' + $PLATFORM_TARGET + '\' + "$CARGO_PROFILE"
}
$BUNDLE_ID = "dev.rook.$app_name"

# Update parameters based on the target release channel.
#
# APP_NAME here must match the value used in Rust as the
# application name; see app/src/channel.rs.
#
# ROOK_BIN is the name of the binary produced by cargo;
# BINARY_NAME is the desired name of the binary in the final package.
if ("$CHANNEL" -eq 'local') {
    $ROOK_BIN = 'rook'
    $BINARY_NAME = 'rook.exe'
    $APP_NAME = 'RookLocal'
} elseif ("$CHANNEL" -eq 'dev') {
    $ROOK_BIN = 'dev'
    $BINARY_NAME = 'dev.exe'
    $APP_NAME = 'RookDev'
    $FEATURES = "$FEATURES,agent_mode_debug"
} elseif ("$CHANNEL" -eq 'preview') {
    $ROOK_BIN = 'preview'
    $BINARY_NAME = 'preview.exe'
    $APP_NAME = 'RookPreview'
    $FEATURES = "$FEATURES,preview_channel"
} elseif ("$CHANNEL" -eq 'stable') {
    $ROOK_BIN = 'stable'
    $BINARY_NAME = 'rook.exe'
    $APP_NAME = 'Rook'
} elseif ("$CHANNEL" -eq 'oss') {
    $ROOK_BIN = 'rook-oss'
    $BINARY_NAME = 'rook-oss.exe'
    $APP_NAME = 'RookOss'
    # The OSS channel does not ship Sentry, so drop the crash_reporting feature
    # (which would otherwise pull in the Sentry SDK as a dependency).
    $FEATURES = 'release_bundle,gui'
}

if ($IS_TUI) {
    $ROOK_BIN = switch ($CHANNEL) {
        'local' { 'rook-tui' }
        'oss' { 'rook-tui-oss' }
        Default { "rook-tui-$CHANNEL" }
    }
    $BINARY_NAME = "$ROOK_BIN.exe"
    $APP_NAME = switch ($CHANNEL) {
        'local' { 'RookAgentCLI' }
        'dev' { 'RookAgentCLIDev' }
        'preview' { 'RookAgentCLIPreview' }
        'stable' { 'RookAgentCLI' }
        'oss' { 'RookAgentCLIOss' }
    }
    $CLI_NAME = switch ($CHANNEL) {
        'local' { 'rook' }
        'dev' { 'rook-dev' }
        'preview' { 'rook-preview' }
        'stable' { 'rook' }
        'oss' { 'rook-oss' }
    }
    $INSTALL_DIR_NAME = switch ($CHANNEL) {
        'local' { 'tui-local' }
        'dev' { 'tui-dev' }
        'preview' { 'tui-preview' }
        'stable' { 'tui' }
        'oss' { 'tui-oss' }
    }
    $FEATURES = 'release_bundle,standalone,voice_input'
    if ("$CHANNEL" -ne 'oss') {
        $FEATURES = "$FEATURES,crash_reporting"
    }
} elseif ($IS_CLI) {
    # The CLI ships the same channel binary target as the app (no separate bin), so keep
    # $ROOK_BIN and the channel-scoped $FEATURES set above (crash_reporting, preview_channel,
    # agent_mode_debug, etc.) but swap the app's `gui` feature for `standalone`, mirroring the
    # macOS and Linux `--artifact cli` builds. Filtering (rather than overwriting) $FEATURES is
    # required so per-channel additions above -- e.g. preview_channel, required by the `preview`
    # cargo target -- survive into the CLI build.
    $BINARY_NAME = "$ROOK_BIN.exe"
    $FEATURES = (($FEATURES -split ',') | Where-Object { $_ -ne 'gui' }) -join ','
    $FEATURES = "$FEATURES,standalone"
} else {
    # All app channels ship the v3 classifier and v2 heuristic.
    $FEATURES = "$FEATURES,nld_classifier_v3,nld_heuristic_v2"
}

# What the installer shows the user, as opposed to what identifies the app.
# $APP_NAME is identity: it feeds the bundle id, the AppUserModelID and the
# per-user data directories, all of which have to keep matching what the Rust
# side derives from the channel. The oss channel is the only one that ships
# under a different name, because in this fork it is not one channel among
# several - it is the product, and users look for it as Rook.
$APP_DISPLAY_NAME = if (-not $IS_TUI -and "$CHANNEL" -eq 'oss') { 'Rook' } else { $APP_NAME }

$BINARY_PATH = "$CARGO_TARGET_OUTPUT_DIR\$BINARY_NAME"
$BUNDLE_ID = "dev.rook.$APP_NAME"
$INSTALLER_OUTPUT_DIR = "$WINDOWS_INSTALLER_DIR\Output"
$INSTALLER_NAME = "$($APP_NAME)$($FILE_ENDING)"
$INSTALLER_PATH = "$($INSTALLER_OUTPUT_DIR)\$($INSTALLER_NAME).exe"
# rustc normalizes hyphens to underscores in crate names, and MSVC uses that
# normalized crate name for the PDB even though Cargo exposes the executable
# under its original hyphenated target name. That holds for the GUI binary as
# much as the TUI one: the OSS channel builds `rook-oss.exe` with
# `rook_oss.pdb`, and a path built from the hyphenated name pointed at nothing.
$PDB_BASENAME = $ROOK_BIN.Replace('-', '_')
$PDB_PATH = "$CARGO_TARGET_OUTPUT_DIR\$PDB_BASENAME.pdb"
$CARGO_PACKAGE = if ($IS_TUI) { 'rook_tui' } else { 'rook' }
$INSTALLER_SCRIPT = if ($IS_TUI) {
    "$WINDOWS_INSTALLER_DIR\tui-installer.iss"
} else {
    "$WINDOWS_INSTALLER_DIR\windows-installer.iss"
}

# The CARGO_FULL_PROFILE environment variable is read by the `cargo` build
# script (`app/build.rs`) to determine where to place `conpty.dll`.
if ($DEBUG_BUILD) {
    $env:CARGO_FULL_PROFILE = 'debug'
} else {
    $env:CARGO_FULL_PROFILE = $CARGO_PROFILE
}

# If we only want to check that compilation will succeed, perform the checks
# then exit.  We use this script to invoke `cargo check` to ensure that we are
# using the same feature flags and profile that we would be using in production.
if ($CHECK_ONLY) {
    cargo check -p $CARGO_PACKAGE --profile "$CARGO_PROFILE" --bin "$ROOK_BIN" --features "$FEATURES" --target $PLATFORM_TARGET
    if (-Not $?) {
        Write-Error "Failed to verify Rook $ROOK_BIN compilation with profile $CARGO_PROFILE"
        exit 1
    }
    exit 0
}

if (-Not $SKIP_BUILD_BINARY) {
    Write-Output "Building Rook for channel $CHANNEL and bundle id $BUNDLE_ID"
    $env:CARGO_BIN_NAME = $CHANNEL
    $env:ROOK_APP_NAME = $APP_NAME
    cargo build -p $CARGO_PACKAGE --profile "$CARGO_PROFILE" --bin "$ROOK_BIN" --features "$FEATURES" --target $PLATFORM_TARGET
    if (-Not $?) {
        Write-Error "Failed to build Rook $ROOK_BIN binary with profile $CARGO_PROFILE"
        exit 1
    }

    # If we desire an executable name different from the cargo bin, rename it.
    if ("$ROOK_BIN.exe" -ne $BINARY_NAME) {
        $binarySource = "$CARGO_TARGET_OUTPUT_DIR\$ROOK_BIN.exe"
        Write-Output "Renaming executable $ROOK_BIN.exe to $BINARY_NAME"
        Move-Item -Path "$binarySource" -Destination "$BINARY_PATH" -Force
    }
}

if ($SKIP_BUILD_INSTALLER) {
    # If this is being run within a GitHub action, set an output variable with the
    # location of the binary so it can be referenced by subsequent actions.
    if ($env:GITHUB_ACTIONS -eq 'true') {
        Write-Output '::echo::on'
        "target_profile_dir=$CARGO_TARGET_OUTPUT_DIR" >> "$env:GITHUB_OUTPUT"
        "binary_path=$BINARY_PATH" >> "$env:GITHUB_OUTPUT"
        "pdb_file_path=$PDB_PATH" >> "$env:GITHUB_OUTPUT"
        Write-Output '::echo::off'
    }
    exit 0
}

Write-Output "Built for $ARCH with executable at $BINARY_PATH"

# Prepare bundled resources
if ($env:SKIP_SETTINGS_SCHEMA -ne '1' -and -not $env:SETTINGS_SCHEMA_EXECUTABLE -and -not $env:SETTINGS_SCHEMA_SOURCE) {
    if ($IS_TUI -or $IS_CLI) {
        Write-Error 'TUI and CLI bundles require SETTINGS_SCHEMA_SOURCE or SETTINGS_SCHEMA_EXECUTABLE.'
        exit 1
    } elseif ($SKIP_BUILD_BINARY) {
        Write-Error '-skip_build_binary requires SETTINGS_SCHEMA_SOURCE or SETTINGS_SCHEMA_EXECUTABLE.'
        exit 1
    } elseif (-not $CAN_EXECUTE_ARCH) {
        Write-Error "Cannot execute the just-built $ARCH binary on this $HOST_ARCH host to generate a settings schema; pass SETTINGS_SCHEMA_SOURCE or SETTINGS_SCHEMA_EXECUTABLE."
        exit 1
    }
    $env:SETTINGS_SCHEMA_EXECUTABLE = $BINARY_PATH
}
$BUNDLED_RESOURCES_DIR = "$CARGO_TARGET_OUTPUT_DIR\resources"
Write-Output 'Preparing bundled resources...'
& "$WINDOWS_INSTALLER_DIR\prepare_bundled_resources.ps1" -DestinationDir "$BUNDLED_RESOURCES_DIR" -Channel "$CHANNEL"
if (-Not $?) {
    Write-Error 'Failed to prepare bundled resources'
    exit 1
}
if ($IS_TUI -or $IS_CLI) {
    # Both the TUI and CLI ship the ConPTY/OpenConsole payload and MSVC redistributable DLLs
    # alongside the binary (see the packaging step in create_release.yml for the CLI, and the
    # Inno Setup script for the TUI). Verify the files exist, and -- when requested -- are
    # signed, before the CLI branch below hands off to the workflow's own packaging step,
    # which otherwise has no way to detect a missing or unsigned sidecar file.
    $WINDOWS_ASSETS_DIR = "$WORKSPACE_ROOT_DIR\app\assets\windows\$ARCH"
    $requiredPayloadFiles = @(
        $BINARY_PATH,
        (Join-Path $WINDOWS_ASSETS_DIR 'conpty.dll'),
        (Join-Path $WINDOWS_ASSETS_DIR 'OpenConsole.exe'),
        (Join-Path $WINDOWS_ASSETS_DIR 'vcruntime140.dll'),
        (Join-Path $WINDOWS_ASSETS_DIR 'vcruntime140_1.dll'),
        (Join-Path $WINDOWS_ASSETS_DIR 'msvcp140.dll')
    )
    foreach ($requiredFile in $requiredPayloadFiles) {
        if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
            throw "Required Rook Agent CLI payload file does not exist: $requiredFile"
        }
        if ($REQUIRE_SIGNATURES) {
            Assert-ValidSignature -Path $requiredFile
        }
    }
}
if ($IS_CLI) {
    # The CLI ships as a bare binary plus its resources dir, mirroring the macOS and Linux
    # `--artifact cli` builds; it has no installer to build, so stop here rather than
    # falling through to the Inno Setup section below.
    if ($env:GITHUB_ACTIONS -eq 'true') {
        Write-Output '::echo::on'
        "binary_path=$BINARY_PATH" >> "$env:GITHUB_OUTPUT"
        "pdb_file_path=$PDB_PATH" >> "$env:GITHUB_OUTPUT"
        "bundled_resources_dir=$BUNDLED_RESOURCES_DIR" >> "$env:GITHUB_OUTPUT"
        Write-Output '::echo::off'
    }
    exit 0
}

Write-Output 'Building Rook installer'
$ISCC_ARGS = @(
    "$INSTALLER_SCRIPT",
    "/DReleaseChannel=$CHANNEL",
    "/DMyAppExeName=$BINARY_NAME",
    "/DTargetProfileDir=$CARGO_TARGET_OUTPUT_DIR",
    "/DMyAppName=$APP_NAME",
    "/DMyAppDisplayName=$APP_DISPLAY_NAME",
    "/DMyAppVersion=$env:GIT_RELEASE_TAG",
    "/DArch=$ARCH",
    "/DOutputName=$INSTALLER_NAME"
)
if ($IS_TUI) {
    $ISCC_ARGS += @(
        "/DWindowsAssetsDir=$WINDOWS_ASSETS_DIR",
        "/DCLIName=$CLI_NAME",
        "/DInstallDirName=$INSTALL_DIR_NAME"
    )
}
# Also accept the sign tool command via env var
if (-not $SIGN_TOOL_CMD -and $env:SIGN_TOOL_CMD) {
    $SIGN_TOOL_CMD = $env:SIGN_TOOL_CMD
}
if ($SIGN_TOOL_CMD) {
    $ISCC_ARGS += '/DSIGN_TOOL=1'
    $ISCC_ARGS += "/Scodesign=$SIGN_TOOL_CMD"
}
& ISCC @ISCC_ARGS
if (-Not $?) {
    Write-Error "Failed to build $APP_NAME installer"
    exit 1
}

# If this is being run within a GitHub action, set an output variable with the
# location of the installer so it can be referenced by subsequent actions.
if ($env:GITHUB_ACTIONS -eq 'true') {
    Write-Output '::echo::on'
    $INSTALLER_PATH = $INSTALLER_PATH -replace '\\', '/'
    "installer_path=$INSTALLER_PATH" >> "$env:GITHUB_OUTPUT"
    "pdb_file_path=$PDB_PATH" >> "$env:GITHUB_OUTPUT"
    Write-Output '::echo::off'
}

if ($IS_TUI) {
    Write-Output "Application installer: $INSTALLER_PATH"
}
