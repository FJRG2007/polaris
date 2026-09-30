/**
 * The one line that installs the browser extension and keeps it up to date.
 *
 * Two places show it, and they must show the same thing: the dashboard's
 * downloads screen (`apps/web/src/lib/install-command.ts`), and the extension's
 * own popup, which names it to a copy that was loaded by hand and is not yet
 * covered by the updater the line sets up. A separate entry point so the popup
 * pulls in this and nothing else of the package.
 *
 * The repository is passed in rather than baked in: a deployment built from a
 * fork has to hand out its own address, not this one's.
 */

export type InstallOs = "windows" | "unix";

/** Both choices, in the order they are offered. */
export const INSTALL_OSES: readonly InstallOs[] = ["windows", "unix"];

/** Where the scripts sit in the repository. */
const SCRIPT_PATH = "dashboard/apps/extension/scripts";

/** The window the line is pasted into, so a line is never offered for the wrong one. */
export function installShell(os: InstallOs): string {
    // i18n-ignore the names of two programs
    return os === "windows" ? "PowerShell" : "Terminal";
}

/** The whole line, ready to paste with nothing to fill in. */
export function installLine(os: InstallOs, repo: string): string {
    const scripts = `https://raw.githubusercontent.com/${repo}/main/${SCRIPT_PATH}`;
    return os === "windows"
        ? `irm ${scripts}/install.ps1 | iex`
        : `curl -fsSL ${scripts}/install.sh | sh`;
}

/**
 * Which line to put in front of the reader first.
 *
 * Windows is the only one worth telling apart, because the other command covers
 * everything else. Anything unrecognised gets the shell line rather than the
 * PowerShell one: that is the answer that is right more often.
 */
export function detectOs(userAgent: string): InstallOs {
    return /windows|win32|win64/i.test(userAgent) ? "windows" : "unix";
}

/**
 * The repository a release page belongs to, read off its address.
 *
 * The extension learns about releases from its own Polaris, which answers with
 * the release's page on GitHub - so that page is where the repository the
 * deployment was built from can be read, rather than assumed. Null for anything
 * that is not a GitHub release page.
 */
export function repoFromReleaseUrl(url: string): string | null {
    const match =
        /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/releases(?:\/|$)/.exec(url);
    return match ? `${match[1]}/${match[2]}` : null;
}
