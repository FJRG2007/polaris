/**
 * Where this app listens for the native messaging host. The host computes the
 * same place (`crates/polaris-native-host/src/ipc.rs`); change both together.
 *
 * - Windows: a named pipe named after the user. Node creates it with the
 *   user's default DACL (only this user, SYSTEM and administrators may write),
 *   and the host checks the pipe's server runs as its own user before it sends.
 * - macOS and Linux: `desktop.sock` in a folder only this user may enter.
 *
 * Pure: the platform, user name and environment are passed in.
 */

import { posix } from "node:path";

/** ASCII letters and digits (lowercased), `.`, `-` and `_` kept; the rest `_`. */
export function endpointUser(name: string): string {
    return Array.from(name, (char) => (/^[A-Za-z0-9._-]$/.test(char) ? char.toLowerCase() : "_")).join("");
}

export function pipeName(user: string): string {
    return `\\\\.\\pipe\\polaris-desktop-native-host-${endpointUser(user)}`;
}

/** The socket's folder on macOS and Linux, or null without an absolute home. */
export function socketDir(platform: NodeJS.Platform, home: string, xdgConfigHome: string | undefined): string | null {
    if (!home.startsWith("/")) return null;
    if (platform === "darwin") return posix.join(home, "Library", "Application Support", "Polaris", "native-host");
    const base = xdgConfigHome?.startsWith("/") ? xdgConfigHome : posix.join(home, ".config");
    return posix.join(base, "Polaris", "native-host");
}

export interface Endpoint {
    /** What `net.Server.listen` takes. */
    readonly path: string;
    /** The private folder it lives in, on macOS and Linux. */
    readonly dir: string | null;
}

export function endpointFor(
    platform: NodeJS.Platform,
    user: string,
    home: string,
    xdgConfigHome: string | undefined
): Endpoint | null {
    if (platform === "win32") return { path: pipeName(user), dir: null };
    const dir = socketDir(platform, home, xdgConfigHome);
    return dir ? { path: posix.join(dir, "desktop.sock"), dir } : null;
}
