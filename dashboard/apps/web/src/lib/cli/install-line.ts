/**
 * The one line that installs the command-line client from this Polaris.
 *
 * Served by the instance itself (`/cli/install.sh`, `/cli/install.ps1`) rather
 * than from a registry: every Polaris is self-hosted, so the CLI a developer gets
 * is the one built with the server it talks to, and an instance nobody can reach
 * from the internet still hands it out. Pure, so the downloads screen and its
 * test build the same line.
 */

import { platformShell, type InstallPlatform } from "@/lib/install-platform";

export interface CliInstallLine {
    /** The window it is pasted into. */
    readonly shell: string;
    /** The whole line, ready to paste with nothing to fill in. */
    readonly command: string;
}

/** The line for a platform, against the address the reader has this page open on. */
export function cliInstallLine(platform: InstallPlatform, origin: string): CliInstallLine {
    const base = origin.replace(/\/+$/, "");
    return platformShell(platform) === "windows"
        ? // i18n-ignore the name of a program
          { shell: "PowerShell", command: `irm ${base}/cli/install.ps1 | iex` }
        : // i18n-ignore the name of a program
          { shell: "Terminal", command: `curl -fsSL ${base}/cli/install.sh | sh` };
}

/** What to type once it is installed: sign in to the Polaris that served it. */
export function cliLoginLine(origin: string): string {
    return `plr login --url ${origin.replace(/\/+$/, "")}`;
}
