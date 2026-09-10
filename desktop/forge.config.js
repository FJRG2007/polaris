// @ts-check
/**
 * Packaging: a Squirrel installer for Windows, a .dmg and a .zip for macOS, and
 * a .deb and an AppImage for Linux.
 *
 * Unsigned unless the signing secrets are in the environment - see README.md for
 * their names. Nothing is signed with a value that is not there.
 */

const path = require("node:path");
const { chmodSync, existsSync, renameSync, writeFileSync } = require("node:fs");

const ICON = path.join(__dirname, "assets", "icon");
const env = process.env;

/** macOS: signed with a Developer ID when one is given, notarized when the Apple
 *  account is given as well. Hardened runtime is what notarization requires. */
const macSigning = env.APPLE_SIGNING_IDENTITY
    ? {
          osxSign: {
              identity: env.APPLE_SIGNING_IDENTITY,
              optionsForFile: () => ({
                  hardenedRuntime: true,
                  entitlements: path.join(__dirname, "entitlements.plist")
              })
          },
          ...(env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID
              ? {
                    osxNotarize: {
                        appleId: env.APPLE_ID,
                        appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD,
                        teamId: env.APPLE_TEAM_ID
                    }
                }
              : {})
      }
    : {};

/** Windows: the executable and the installer, signed with a code-signing
 *  certificate file when one is given. */
const windowsCertificate =
    env.WINDOWS_CERTIFICATE_FILE && existsSync(env.WINDOWS_CERTIFICATE_FILE)
        ? { certificateFile: env.WINDOWS_CERTIFICATE_FILE, certificatePassword: env.WINDOWS_CERTIFICATE_PASSWORD ?? "" }
        : null;

module.exports = {
    packagerConfig: {
        name: "Polaris",
        executableName: "polaris",
        appBundleId: "io.github.fjrg2007.polaris",
        appCategoryType: "public.app-category.developer-tools",
        // macOS asks before a call reaches the microphone or camera, and shows
        // these words when it does.
        extendInfo: {
            NSMicrophoneUsageDescription: "Polaris uses the microphone for calls in Chat.",
            NSCameraUsageDescription: "Polaris uses the camera for video calls in Chat."
        },
        icon: ICON,
        asar: true,
        // The main process and preloads are bundled into dist/ (build/bundle.mjs),
        // so the app needs no node_modules: ship dist/ and package.json only.
        prune: false,
        ignore: (/** @type {string} */ file) => {
            if (!file) return false;
            const relative = file.replace(/^[\\/]/, "").replaceAll("\\", "/");
            return !(relative === "package.json" || relative === "dist" || relative.startsWith("dist/"));
        },
        ...(windowsCertificate ? { windowsSign: windowsCertificate } : {}),
        ...macSigning
    },
    hooks: {
        /**
         * Linux: where the system forbids unprivileged user namespaces (Ubuntu
         * 24.04 and later by default) and the SUID helper cannot be used (an
         * AppImage is mounted nosuid), Chromium's sandbox cannot start and the app
         * aborts before its first window. The launcher adds --no-sandbox in exactly
         * those cases and nowhere else; everywhere the sandbox can run, it runs.
         */
        postPackage: async (_config, options) => {
            if (options.platform !== "linux") return;
            for (const out of options.outputPaths) {
                const exe = path.join(out, "polaris");
                if (!existsSync(exe)) continue;
                renameSync(exe, path.join(out, "polaris.bin"));
                writeFileSync(
                    exe,
                    [
                        "#!/bin/sh",
                        'self="$0"',
                        'case "$self" in */*) ;; *) self="$(command -v -- "$self")" || self="$0";; esac',
                        'dir="$(dirname "$(readlink -f "$self")")"',
                        'if { [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = "1" ] &&',
                        '     [ "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null)" = "Y" ]; } ||',
                        '   [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)" = "0" ] ||',
                        '   [ "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null)" = "0" ]; then',
                        '  set -- --no-sandbox "$@"',
                        "fi",
                        'exec "$dir/polaris.bin" "$@"',
                        ""
                    ].join("\n")
                );
                chmodSync(exe, 0o755);
            }
        }
    },
    makers: [
        {
            name: "@electron-forge/maker-squirrel",
            platforms: ["win32"],
            config: {
                name: "polaris",
                setupExe: "Polaris-Setup.exe",
                setupIcon: `${ICON}.ico`,
                ...(windowsCertificate ?? {})
            }
        },
        {
            name: "@electron-forge/maker-dmg",
            platforms: ["darwin"],
            // No name: forge then names it Polaris-<version>-<arch>.dmg, so the
            // arm64 and x64 images can sit in one release.
            config: { icon: `${ICON}.icns` }
        },
        {
            name: "@electron-forge/maker-zip",
            platforms: ["darwin"]
        },
        {
            name: "@electron-forge/maker-deb",
            platforms: ["linux"],
            config: {
                options: {
                    name: "polaris-desktop",
                    productName: "Polaris",
                    bin: "polaris",
                    icon: `${ICON}.png`,
                    categories: ["Development", "Utility"]
                }
            }
        },
        {
            name: "@reforged/maker-appimage",
            platforms: ["linux"],
            config: {
                options: {
                    bin: "polaris",
                    icon: `${ICON}.png`,
                    categories: ["Development", "Utility"],
                    // A runtime downloaded and checked against its digest by the
                    // workflow; without one the maker fetches the moving
                    // "continuous" build, which is fine for a local try only.
                    ...(env.APPIMAGE_RUNTIME ? { runtime: env.APPIMAGE_RUNTIME } : {})
                }
            }
        }
    ]
};
