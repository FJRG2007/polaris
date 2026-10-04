/**
 * The systems an install line is offered for, as the reader names them.
 *
 * The scripts themselves only care about two shells - PowerShell, and `sh` for
 * everything else - but a picker that says "macOS and Linux" cannot show either
 * system's mark, and somebody scanning for their own system looks for its logo
 * before its name. So the picker offers three, and macOS and Linux map to the
 * same line underneath.
 *
 * Pure, so the downloads screen and its tests share it.
 */

import type { InstallOs } from "@polaris/core/extension-install";

export type InstallPlatform = "windows" | "macos" | "linux";

/** Every choice, in the order the picker offers them. */
export const INSTALL_PLATFORMS: readonly InstallPlatform[] = ["windows", "macos", "linux"];

/** Each system's name, which is the same in every language. */
export const PLATFORM_LABELS: Readonly<Record<InstallPlatform, string>> = {
    // i18n-ignore a system's name
    windows: "Windows",
    // i18n-ignore a system's name
    macos: "macOS",
    // i18n-ignore a system's name
    linux: "Linux"
};

/** The shell family a platform's line is written for. */
export function platformShell(platform: InstallPlatform): InstallOs {
    return platform === "windows" ? "windows" : "unix";
}

/**
 * Which system to put first. Anything unrecognised is offered Linux, since the
 * line for it is the one that works on every system that is not Windows.
 */
export function detectPlatform(userAgent: string): InstallPlatform {
    if (/windows|win32|win64/i.test(userAgent)) return "windows";
    if (/macintosh|mac os x/i.test(userAgent)) return "macos";
    return "linux";
}
