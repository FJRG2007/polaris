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
 * It puts the extension in one fixed folder and sets up a job of the user's own
 * that replaces the files there when a new version is published; the extension
 * notices and restarts into them. Running it again is safe and changes nothing
 * that is already current.
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

import {
    INSTALL_OSES,
    detectOs,
    installLine,
    installShell,
    type InstallOs
} from "@polaris/core/extension-install";

export { INSTALL_OSES, detectOs, type InstallOs };

export interface InstallCommand {
    readonly os: InstallOs;
    /** What to call this choice, in the reader's terms rather than the kernel's. */
    readonly label: string;
    /** The window it is pasted into, so a line is never offered for the wrong one. */
    readonly shell: string;
    /** The whole line, ready to paste with nothing to fill in. */
    readonly command: string;
}

/** The line itself is built in `@polaris/core/extension-install`, which the
 *  extension's popup reads too, so the two can never offer different lines. */
export function installCommand(os: InstallOs, repo: string): InstallCommand {
    return {
        os,
        label:
            os === "windows"
                ? // i18n-ignore a system's name
                  "Windows"
                : // i18n-ignore the downloads screen says it in the reader's words
                  "macOS and Linux",
        shell: installShell(os),
        command: installLine(os, repo)
    };
}
