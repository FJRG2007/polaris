/**
 * The one line that installs the command-line client, and the one that signs it
 * in to this Polaris.
 *
 * The CLI is installed from the project's GitHub releases, the same way the
 * browser extension is: the line runs the install script from the repository
 * this deployment updates from, and that script fetches the newest `cli-v*`
 * release and checks it against the digest GitHub publishes. Which Polaris it
 * talks to is said afterwards, with `plr login --url`, and the two check they
 * speak the same API on every call. Pure, so the downloads screen and its test
 * build the same lines.
 */

import { platformShell, type InstallPlatform } from "@/lib/install-platform";

/** Where the scripts sit in the repository. */
const SCRIPT_PATH = "dashboard/packages/cli/scripts";

export interface CliInstallLine {
    /** The window it is pasted into. */
    readonly shell: string;
    /** The whole line, ready to paste with nothing to fill in. */
    readonly command: string;
}

/** The line for a platform, from the repository's official scripts. */
export function cliInstallLine(platform: InstallPlatform, repo: string): CliInstallLine {
    const scripts = `https://raw.githubusercontent.com/${repo}/main/${SCRIPT_PATH}`;
    return platformShell(platform) === "windows"
        ? // i18n-ignore the name of a program
          { shell: "PowerShell", command: `irm ${scripts}/install.ps1 | iex` }
        : // i18n-ignore the name of a program
          { shell: "Terminal", command: `curl -fsSL ${scripts}/install.sh | sh` };
}

/** What to type once it is installed: sign in to this Polaris. */
export function cliLoginLine(origin: string): string {
    return `plr login --url ${origin.replace(/\/+$/, "")}`;
}
