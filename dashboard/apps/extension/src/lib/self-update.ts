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

/** What the updater's last run says it found (`check` in the marker). */
export type CheckOutcome = "current" | "installed" | "failed";

/** Why the updater says a run failed, as the install scripts spell it. */
export const TROUBLE_REASONS = [
    "unreachable",
    "no-release",
    "no-package",
    "digest",
    "bad-package",
    "install",
    "task",
    "missing-tool",
    "unknown"
] as const;

/** A reason the updater gave, or `stopped`: it has not run for hours. */
export type TroubleReason = (typeof TROUBLE_REASONS)[number] | "stopped";

/** The updater's last run, read from the marker. */
export interface UpdaterCheck {
    /** When it ran, ms. */
    readonly at: number;
    readonly outcome: CheckOutcome;
    readonly reason: string | null;
    /** What went wrong in the updater's own words (an error message), or null. */
    readonly detail: string | null;
    /** How often it runs. */
    readonly everyMinutes: number;
}

/** Automatic updates that are not arriving, and why. */
export interface UpdaterTrouble {
    readonly reason: TroubleReason;
    readonly detail: string | null;
    /** When the updater last ran, ms. */
    readonly at: number;
}

/** The longest detail shown: an error message, not a log. */
const DETAIL_LIMIT = 300;

/**
 * The updater's last run, or null when the note has none - an updater from
 * before it wrote one, which `update.effectiveKind`'s grace period covers.
 */
export function lastCheck(note: unknown): UpdaterCheck | null {
    if (typeof note !== "object" || note === null) return null;
    const check = (note as { check?: unknown }).check;
    if (typeof check !== "object" || check === null) return null;
    const held = check as Record<string, unknown>;
    const at = typeof held.at === "string" ? Date.parse(held.at) : Number.NaN;
    const outcome = held.outcome;
    if (!Number.isFinite(at)) return null;
    if (outcome !== "current" && outcome !== "installed" && outcome !== "failed") return null;
    const every = typeof held.everyMinutes === "number" && held.everyMinutes > 0 ? held.everyMinutes : 60;
    const detail =
        typeof held.detail === "string" && held.detail.trim() !== ""
            ? held.detail.trim().slice(0, DETAIL_LIMIT)
            : null;
    return {
        at,
        outcome,
        reason: typeof held.reason === "string" && held.reason !== "" ? held.reason : null,
        detail,
        everyMinutes: every
    };
}

/** How many runs may go missing before the updater counts as stopped. */
const MISSED_RUNS = 3;

/**
 * Whether automatic updates have stopped working, and why - or null.
 *
 * `behind` is a newer version out that is not on disk yet. A run that could not
 * reach GitHub only counts then: a laptop offline for an hour has lost nothing,
 * and the next run tries again. Any other failure counts at once, because the
 * next release will meet it too. A run that last went well counts once a newer
 * version has been out for several of its periods without it running again -
 * the task removed, disabled, or the computer never awake when it is due.
 */
export function updaterTrouble(note: unknown, now: number, behind: boolean): UpdaterTrouble | null {
    if (!coveredBy(note)) return null;
    const check = lastCheck(note);
    if (!check) return null;
    if (check.outcome === "failed") {
        const reason = (TROUBLE_REASONS as readonly string[]).includes(check.reason ?? "")
            ? (check.reason as TroubleReason)
            : "unknown";
        if (reason === "unreachable" && !behind) return null;
        return { reason, detail: check.detail, at: check.at };
    }
    // A clock moved backwards is not hours of silence.
    if (!behind || check.at > now) return null;
    return now - check.at > MISSED_RUNS * check.everyMinutes * 60 * 1000
        ? { reason: "stopped", detail: null, at: check.at }
        : null;
}
