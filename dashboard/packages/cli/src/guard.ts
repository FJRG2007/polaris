/**
 * Refusing to run where a Polaris SERVER is installed.
 *
 * The two are not compatible on one machine by design: a server install puts
 * its own management script on PATH under the same two names this CLI answers
 * to (`polaris` and `plr` - `/usr/local/bin` on Linux and macOS,
 * `%LOCALAPPDATA%\Polaris\bin` on Windows), and whichever comes first on PATH
 * silently wins. An operator typing `polaris status` to see their stack and
 * getting a developer CLI's answer - or the other way round - is the collision
 * this exists to prevent. So the installer refuses, and the CLI checks again at
 * startup, which also catches a server installed after the CLI was.
 *
 * What a server install leaves behind, and what is looked for (any one is
 * enough; all of it is read, nothing is ever changed):
 *
 * - its management script, recognised by its own header line rather than by
 *   name, so this CLI's launchers are never mistaken for it;
 * - its checkout with the compose file (`/opt/polaris`, or
 *   `%ProgramData%\Polaris` on Windows, or wherever `POLARIS_INSTALL_DIR` says);
 * - its durable secrets store (`/var/lib/polaris/secrets.env`, or
 *   `%ProgramData%\Polaris\secrets.env`).
 *
 * Only file checks, so the startup check costs a few `stat`s. The install
 * script also asks Docker for a running `polaris` compose project, which is too
 * slow to do on every command.
 */

import type { Host } from "./paths.js";
import { posix, win32 } from "node:path";

/** How the guard reads the disk, so a test can hand it a fixture filesystem. */
export interface Probe {
    exists(path: string): boolean;
    /** The file's text, or null when it cannot be read. */
    read(path: string): string | null;
}

/** The first line of the server's own management script, on both systems. */
export const SERVER_SCRIPT_SIGNATURE = "manage a Polaris dashboard deployment";

export interface ServerInstall {
    readonly found: boolean;
    /** What was found, as a sentence fragment each, for the refusal message. */
    readonly evidence: readonly string[];
}

/** Every place a server install would have left something, on this system. */
function candidates(host: Host): { scripts: string[]; files: string[] } {
    if (host.platform === "win32") {
        const local = host.env.LOCALAPPDATA ?? win32.join(host.home, "AppData", "Local");
        const shared = host.env.ProgramData ?? host.env.PROGRAMDATA ?? "C:\\ProgramData";
        const checkout = host.env.POLARIS_INSTALL_DIR || win32.join(shared, "Polaris");
        return {
            scripts: [win32.join(local, "Polaris", "bin", "polaris.ps1")],
            files: [
                win32.join(checkout, "dashboard", "docker", "docker-compose.yml"),
                win32.join(shared, "Polaris", "secrets.env")
            ]
        };
    }
    const checkout = host.env.POLARIS_INSTALL_DIR || "/opt/polaris";
    return {
        scripts: ["/usr/local/bin/polaris", "/usr/local/bin/plr"],
        files: [
            posix.join(checkout, "dashboard", "docker", "docker-compose.yml"),
            host.env.POLARIS_SECRETS_FILE || "/var/lib/polaris/secrets.env"
        ]
    };
}

/** Whether this machine carries a Polaris server install, and what says so. */
export function detectServerInstall(host: Host, probe: Probe): ServerInstall {
    const { scripts, files } = candidates(host);
    const evidence: string[] = [];
    for (const script of scripts) {
        const text = probe.exists(script) ? probe.read(script) : null;
        if (text?.includes(SERVER_SCRIPT_SIGNATURE))
            evidence.push(`the server's own command at ${script}`);
    }
    for (const file of files) {
        if (probe.exists(file)) evidence.push(file);
    }
    return { found: evidence.length > 0, evidence };
}

/** The refusal, in words that say why and what to do instead. */
export function serverInstallMessage(found: ServerInstall): string {
    return [
        "This computer runs a Polaris server, so the developer CLI will not run here.",
        "Both answer to `polaris` and `plr`, and on one machine one of them would silently replace the other.",
        `Found: ${found.evidence.join("; ")}.`,
        "Use the CLI from another computer, or manage this server with its own `polaris` command (try `polaris help`)."
    ].join("\n");
}
