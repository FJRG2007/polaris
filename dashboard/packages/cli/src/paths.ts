/**
 * Where the CLI keeps things on each system.
 *
 * Deliberately not where the Polaris SERVER keeps its own: the server's
 * management script stores a sign-in under `~/.config/polaris/cli` and lives in
 * `/usr/local/bin` or `%LOCALAPPDATA%\Polaris\bin`. Everything here is named
 * `polaris-cli`, so the two can never read or overwrite each other's files - even
 * though the install guard already keeps them off the same machine.
 *
 * Pure: the system, the environment and the home directory are passed in, so a
 * test can ask for any of them.
 */

import { posix, win32 } from "node:path";

/** What a path decision depends on. */
export interface Host {
    readonly platform: NodeJS.Platform;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly home: string;
}

/** The current process, as a `Host`. */
export function currentHost(): Host {
    return {
        platform: process.platform,
        env: process.env,
        home: process.env.HOME ?? process.env.USERPROFILE ?? ""
    };
}

function pathFor(host: Host) {
    return host.platform === "win32" ? win32 : posix;
}

/** Where the profiles (and the token file, when there is no keychain) live. */
export function configDir(host: Host): string {
    const override = host.env.POLARIS_CLI_CONFIG_DIR;
    if (override) return override;
    const path = pathFor(host);
    if (host.platform === "win32") {
        return path.join(
            host.env.APPDATA ?? path.join(host.home, "AppData", "Roaming"),
            "polaris-cli"
        );
    }
    if (host.platform === "darwin")
        return path.join(host.home, "Library", "Application Support", "polaris-cli");
    return path.join(host.env.XDG_CONFIG_HOME || path.join(host.home, ".config"), "polaris-cli");
}

/** Where the installer puts the bundle. The launchers sit beside it on Windows. */
export function installDir(host: Host): string {
    const path = pathFor(host);
    if (host.platform === "win32") {
        return path.join(
            host.env.LOCALAPPDATA ?? path.join(host.home, "AppData", "Local"),
            "Programs",
            "polaris-cli"
        );
    }
    return path.join(
        host.env.XDG_DATA_HOME || path.join(host.home, ".local", "share"),
        "polaris-cli"
    );
}

/** Where the `plr` and `polaris` launchers go. */
export function binDir(host: Host): string {
    if (host.platform === "win32") return installDir(host);
    return posix.join(host.home, ".local", "bin");
}

/** The launcher file names on this system. */
export function launcherNames(host: Host): readonly string[] {
    return host.platform === "win32" ? ["plr.cmd", "polaris.cmd"] : ["plr", "polaris"];
}

/** Written into every launcher and the install marker, so a server installer can
 *  tell this CLI's `polaris` apart from its own. */
export const CLI_MARKER = "polaris-developer-cli";

/** The file the installer leaves beside the bundle, naming where it came from. */
export const INSTALL_MARKER_FILE = "polaris-cli.json";
