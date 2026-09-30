/**
 * Starting a newer version that the updater put on disk.
 *
 * Chromium will not let an extension install itself from anywhere but a store,
 * so the install script does the nearest real thing: it keeps the unpacked copy
 * in one fixed folder and leaves a scheduled job behind that swaps a new release
 * into that folder (`scripts/install.ps1`, `scripts/install.sh`). What is left
 * for the extension is to notice, and restart into the new files.
 *
 * Noticing is cheap because of how an unpacked extension is served: its own
 * files are read from the folder on every request, so fetching its own
 * `manifest.json` answers with what is on disk now, while
 * `runtime.getManifest()` answers with what is running. Checked in a real Brave
 * and Chrome: after the folder is swapped the fetch reports the new version at
 * once, and `runtime.reload()` comes back running it.
 *
 * Restarting is not free, and that decides WHEN. A reload is a browser restart
 * as far as the extension is concerned - session storage is cleared (also
 * checked), and that is where the vault's session and every set-aside account
 * live, on purpose. So it waits for a moment where the restart costs nothing
 * anybody is in the middle of: no vault open, no account set aside on another
 * server, no login being filled or held to be offered, no approval being
 * waited on, no popup open, nothing being answered. A vault that is open all
 * day is started into on the next browser start instead, which loads the new
 * folder by itself - or from the popup's "Start it now", which says what it
 * costs.
 *
 * Everything here is pure; the worker supplies the facts.
 */

import { isNewer } from "@/lib/update";

/** The file the updater writes into the folder it keeps current. */
export const UPDATER_MARKER = "polaris-updater.json";

/**
 * Whether the updater's note says this copy is kept current.
 *
 * Any readable note with an updater other than `none` - which is what a pinned
 * install writes, since a pinned version is one somebody chose to stay on.
 * Anything unreadable is "not covered", the direction that keeps the manual
 * instructions on screen rather than promising an update nothing will deliver.
 */
export function coveredBy(note: unknown): boolean {
    if (typeof note !== "object" || note === null) return false;
    const updater = (note as { updater?: unknown }).updater;
    return typeof updater === "string" && updater !== "" && updater !== "none";
}

/** The version a manifest read from disk declares, or null. */
export function versionIn(manifest: unknown): string | null {
    if (typeof manifest !== "object" || manifest === null) return null;
    const version = (manifest as { version?: unknown }).version;
    return typeof version === "string" && version !== "" ? version : null;
}

/**
 * The version waiting on disk to be started, or null when there is none.
 *
 * Only a NEWER one. An older one on disk is somebody having put a previous
 * release back by hand, and restarting into it unasked would be the extension
 * downgrading itself.
 */
export function waitingVersion(running: string, onDisk: string | null): string | null {
    return onDisk !== null && isNewer(onDisk, running) ? onDisk : null;
}

/** What is going on right now that a restart would cut short. */
export interface InFlight {
    /** A vault key is held - the one in front, or a set-aside account's. */
    readonly vaultOpen: boolean;
    /** Another server's account is set aside, its connection held in session storage only. */
    readonly accountsParked: boolean;
    /** A submitted login held to be offered, or a sign-in part way through. */
    readonly holdingLogin: boolean;
    /** An approval somebody went off to give, for the vault or the connection. */
    readonly awaitingApproval: boolean;
    /** The popup is on screen. */
    readonly popupOpen: boolean;
    /** A message is being answered - a fill among them. */
    readonly answering: boolean;
}

/** Whether a restart now would interrupt nothing. */
export function safeToRestart(now: InFlight): boolean {
    return (
        !now.vaultOpen &&
        !now.accountsParked &&
        !now.holdingLogin &&
        !now.awaitingApproval &&
        !now.popupOpen &&
        !now.answering
    );
}
