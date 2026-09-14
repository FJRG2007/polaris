/**
 * The one line that installs the browser extension, and the same line that
 * updates it.
 *
 * The scripts it names already exist in the repository. What was missing was
 * anywhere in Polaris that said so, which left the download screen offering a
 * zip and five manual steps and nothing else - so the way to keep the extension
 * current was to repeat the whole install, which is exactly what the scripts
 * were written to avoid.
 *
 * Running it a second time replaces the extension in the same fixed folder, and
 * an unpacked extension is re-read from the folder it was loaded from. That is
 * what turns an update into the refresh arrow on the extensions page rather than
 * another "Load unpacked".
 *
 * Held as values rather than written into the page, so the address is built in
 * one place and can be asserted without a DOM. The repository is passed in
 * rather than baked in: a deployment built from a fork has to hand out its own
 * address, not this one's.
 *
 * Firefox is absent here exactly as it is in the scripts: a temporary add-on
 * lives in about:debugging until Firefox closes, so there is nothing on disk for
 * a script to keep current.
 */

export type InstallOs = "windows" | "unix";

/** Where the scripts sit in the repository. */
const SCRIPT_PATH = "dashboard/apps/extension/scripts";

export interface InstallCommand {
    readonly os: InstallOs;
    /** What to call this choice, in the reader's terms rather than the kernel's. */
    readonly label: string;
    /** The window it is pasted into, so a line is never offered for the wrong one. */
    readonly shell: string;
    /** The whole line, ready to paste with nothing to fill in. */
    readonly command: string;
}

/** Both choices, in the order they are offered. */
export const INSTALL_OSES: readonly InstallOs[] = ["windows", "unix"];

export function installCommand(os: InstallOs, repo: string): InstallCommand {
    const scripts = `https://raw.githubusercontent.com/${repo}/main/${SCRIPT_PATH}`;
    if (os === "windows") {
        return {
            os,
            label: "Windows",
            shell: "PowerShell",
            command: `irm ${scripts}/install.ps1 | iex`
        };
    }
    return {
        os,
        label: "macOS and Linux",
        shell: "Terminal",
        command: `curl -fsSL ${scripts}/install.sh | sh`
    };
}

/**
 * Which line to put in front of the reader first.
 *
 * Windows is the only one worth telling apart, because the other command covers
 * everything else. Anything unrecognised gets the shell line rather than the
 * PowerShell one: that is the answer that is right more often, and both are one
 * click apart in the picker anyway.
 */
export function detectOs(userAgent: string): InstallOs {
    return /windows|win32|win64/i.test(userAgent) ? "windows" : "unix";
}
