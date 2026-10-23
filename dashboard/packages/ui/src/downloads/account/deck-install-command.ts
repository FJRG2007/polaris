/**
 * The one line that installs Polaris for Stream Deck, and keeps it current.
 *
 * The same shape as the extension's (`install-command.ts`): a script in the
 * repository fetches the newest `streamdeck-v*` release, unpacks it into the
 * Stream Deck app's plugins folder and leaves a job of the user's own that does
 * the same whenever a newer one is out. Running it again is safe.
 *
 * Only for the systems Elgato's app runs on. Linux has OpenDeck, whose plugins
 * folder is not documented, so it is installed from OpenDeck's own Plugins page
 * and no line is offered for it.
 *
 * The repository is passed in rather than baked in: a deployment built from a
 * fork has to hand out its own address, not this one's.
 */

import { installShell } from "@polaris/core/extension-install";
import type { InstallPlatform } from "./install-platform";

/** The systems the line is offered for. */
export type DeckLinePlatform = Exclude<InstallPlatform, "linux">;

/** Both choices, in the order they are offered. */
export const DECK_LINE_PLATFORMS: readonly DeckLinePlatform[] = ["windows", "macos"];

/** Where the scripts sit in the repository. */
const SCRIPT_PATH = "dashboard/apps/streamdeck/scripts";

export interface DeckInstallCommand {
    readonly platform: DeckLinePlatform;
    /** The window it is pasted into, so a line is never offered for the wrong one. */
    readonly shell: string;
    /** The whole line, ready to paste with nothing to fill in. */
    readonly command: string;
}

export function deckInstallCommand(platform: DeckLinePlatform, repo: string): DeckInstallCommand {
    const scripts = `https://raw.githubusercontent.com/${repo}/main/${SCRIPT_PATH}`;
    const os = platform === "windows" ? "windows" : "unix";
    return {
        platform,
        shell: installShell(os),
        command:
            os === "windows"
                ? `irm ${scripts}/install.ps1 | iex`
                : `curl -fsSL ${scripts}/install.sh | sh`
    };
}

/** Which line to put first for the system the reader is on. Somebody reading
 *  on Linux is setting up another computer, and most of those run Windows. */
export function deckLinePlatform(platform: InstallPlatform): DeckLinePlatform {
    return platform === "macos" ? "macos" : "windows";
}
