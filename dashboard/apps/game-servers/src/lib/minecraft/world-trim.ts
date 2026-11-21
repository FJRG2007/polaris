/**
 * Keeping a world down to the part of it anybody has been in.
 *
 * A Minecraft world only grows. Every chunk a player loads is written to disk and
 * kept for good, and most of what gets loaded is scenery at the edge of somebody's
 * view distance that nobody ever walks into. On a server that has been up a year
 * that is the majority of the world by size: on the one this was measured against,
 * 55,790 chunks of 78,373 had never been stood in, and taking them out took the
 * world from 585 MB to 204 MB.
 *
 * Deleting them is safe in the specific sense that matters: the game regenerates
 * a missing chunk from the seed, identically, the next time somebody goes there.
 * What is NOT regenerable is anything a player changed, and the test for that is
 * the chunk's own `InhabitedTime` - the ticks a player has spent inside it, which
 * the game counts for its own reasons. Nobody builds anything without standing
 * next to it.
 *
 * This file is the decisions; `world-trim-service` is the doing, and the script
 * that reads the region files is `world-trim-script`.
 *
 * On by default, including on servers that already exist. The two reasons that is
 * defensible rather than reckless: it only ever runs while the server is stopped,
 * so it cannot race the thing writing those files; and it runs after a backup, so
 * the one case it cannot reason about - somebody wanted a chunk it had no way to
 * know was wanted - is recoverable rather than final.
 */

import { gameMessage } from "../game-message";
import { formatBytes } from "@polaris/core";

/** Where the settings live on the install, beside the schedule and the rest. */
export const WORLD_TRIM_KEY = "worldTrim";

/** Where the last run is recorded, so a screen can say what it did and the sweep
 *  can tell a world it has already done from one it has not. */
export const WORLD_TRIM_RUN_KEY = "worldTrimRun";

export interface WorldTrimSettings {
    /** Whether Polaris may do this on its own. Manual runs ignore it. */
    readonly enabled: boolean;
    /**
     * Keep a chunk with more than this many ticks of inhabited time.
     *
     * Nought means "keep everything anybody has ever been inside", which is the
     * only threshold that needs no judgement about how long counts as a visit.
     * Raising it deletes more and starts making that judgement: 200 is ten
     * seconds of somebody standing there.
     */
    readonly keepTicks: number;
    /** Chunks kept around spawn and around where each player was standing. */
    readonly keepRadius: number;
    /** How long between automatic runs. A world does not accumulate junk fast
     *  enough to be worth doing this often, and every run is a restart. */
    readonly everyDays: number;
}

/** See `trimDue`: no automatic run may happen on any server. */
export const AUTOMATIC_TRIM_DISABLED = true;

export const WORLD_TRIM_DEFAULTS: WorldTrimSettings = {
    enabled: false,
    keepTicks: 0,
    keepRadius: 8,
    everyDays: 14
};

/** What the last run did. */
export interface WorldTrimRun {
    readonly at: string;
    readonly ok: boolean;
    /** Chunks taken out, and bytes the world lost. Nought for a run that failed. */
    readonly removed: number;
    readonly freedBytes: number;
    /** Why it did not work, in words for the screen. Empty when it did. */
    readonly detail: string;
    /**
     * Who asked for it. Only written since 2026-11-21: a run without it is one
     * from before, which may have been automatic and taken no backup.
     */
    readonly trigger: "button" | "automatic" | null;
    /** The backup taken right before it, by archive name, when there was one. */
    readonly backup: string | null;
    /** The operator said the world is fine after it, so the screen stops asking. */
    readonly acknowledged: boolean;
}

/** The settings out of a stored config blob, with anything malformed falling back
 *  to the default rather than throwing: it is a blob written by an older version
 *  of this screen, and a bad entry must not take down the page that would fix it. */
export function readWorldTrim(config: Record<string, unknown>): WorldTrimSettings {
    const raw = config[WORLD_TRIM_KEY];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return WORLD_TRIM_DEFAULTS;
    const value = raw as Partial<Record<keyof WorldTrimSettings, unknown>>;
    return {
        // Absent means the default, which is off.
        enabled: value.enabled === undefined ? WORLD_TRIM_DEFAULTS.enabled : value.enabled === true,
        keepTicks: clamp(value.keepTicks, 0, 24_000 * 30, WORLD_TRIM_DEFAULTS.keepTicks),
        keepRadius: clamp(value.keepRadius, 0, 64, WORLD_TRIM_DEFAULTS.keepRadius),
        everyDays: clamp(value.everyDays, 1, 365, WORLD_TRIM_DEFAULTS.everyDays)
    };
}

function clamp(value: unknown, low: number, high: number, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(high, Math.max(low, Math.round(value)));
}

/** What the last run did, or null when there has not been one. */
export function readWorldTrimRun(config: Record<string, unknown>): WorldTrimRun | null {
    const raw = config[WORLD_TRIM_RUN_KEY];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    if (typeof value.at !== "string") return null;
    return {
        at: value.at,
        ok: value.ok !== false,
        removed: typeof value.removed === "number" ? value.removed : 0,
        freedBytes: typeof value.freedBytes === "number" ? value.freedBytes : 0,
        detail: typeof value.detail === "string" ? value.detail : "",
        trigger: value.trigger === "button" || value.trigger === "automatic" ? value.trigger : null,
        backup: typeof value.backup === "string" ? value.backup : null,
        acknowledged: value.acknowledged === true
    };
}

/**
 * Whether Polaris should do this on its own right now.
 *
 * Four conditions, and the interesting one is the last. A world is optimized
 * while the server is down, and the server is only down at moments Polaris did
 * not choose - a sleeping schedule, somebody stopping it, a machine that was
 * rebooted. So this does not ask for a stop: it waits for one, which is why a
 * server that is never off is a server this never touches. That is the correct
 * trade. Stopping a running server to save disk is not a decision a background
 * sweep gets to make.
 */
export function trimDue(
    settings: WorldTrimSettings,
    last: WorldTrimRun | null,
    now: Date,
    condition: { running: boolean; edition: "java" | "bedrock" }
): boolean {
    // Automatic runs are off for every server, whatever was saved. A run on a
    // stopped server takes no backup, and "never stood in" is not "never used":
    // on 2026-11-21 one deleted 443 chunks holding chests, beds and signs, all
    // with an InhabitedTime of 0, and left the rewritten region files owned by
    // root so the server could not save over them (BUG-0009). The script now
    // keeps anything holding something, refuses worlds where inhabited time is
    // not evidence, backs up first and keeps owners - and still only a person
    // pressing the button, who is shown the result and its backup, may run it.
    if (AUTOMATIC_TRIM_DISABLED) return false;
    if (!settings.enabled) return false;
    // Bedrock keeps its world in a key-value store rather than in region files.
    if (condition.edition !== "java") return false;
    if (condition.running) return false;
    if (!last) return true;
    const since = now.getTime() - Date.parse(last.at);
    if (Number.isNaN(since)) return true;
    // A run that failed is retried on the same cadence rather than immediately:
    // whatever stopped it - no python in the image, a daemon too old - will still
    // be true in a minute, and a sweep that retries every minute is a log full of
    // the same failure.
    return since >= settings.everyDays * 86_400_000;
}

/** What the script printed, read back. */
export interface WorldTrimReport {
    readonly dryRun: boolean;
    readonly dimensions: number;
    readonly regions: number;
    readonly kept: number;
    readonly removed: number;
    readonly freedBytes: number;
    /** Region files it would not touch, with the reason. Empty is the ordinary
     *  case; anything here is a file left exactly as it was. */
    readonly skipped: readonly { file: string; why: string }[];
    /** The copy the script took and read back before it rewrote anything. */
    readonly backup: { readonly name: string; readonly sizeBytes: number } | null;
    /** Why the script would not go ahead, when it would not. Nothing was written. */
    readonly refused: WorldTrimRefusal | null;
}

/**
 * The reasons the script stops a whole run before it writes anything: more than
 * half of a dimension's finished chunks would go, the world does not count
 * inhabited time, or the backup could not be made, or made whole.
 */
export type WorldTrimRefusal =
    | { readonly reason: "share"; readonly share: number; readonly limit: number }
    | { readonly reason: "untracked" }
    | { readonly reason: "room"; readonly free: number; readonly size: number }
    | { readonly reason: "backup"; readonly detail: string };

function readRefusal(value: unknown): WorldTrimRefusal | null {
    if (typeof value !== "object" || value === null) return null;
    const row = value as Record<string, unknown>;
    switch (row.reason) {
        case "share":
            return { reason: "share", share: numberOf(row.share), limit: numberOf(row.limit) };
        case "untracked":
            return { reason: "untracked" };
        case "room":
            return { reason: "room", free: numberOf(row.free), size: numberOf(row.size) };
        default:
            // Any refusal this side does not know the name of is still a refusal:
            // the script wrote nothing, and saying otherwise would be the lie.
            return { reason: "backup", detail: typeof row.detail === "string" ? row.detail : "" };
    }
}

/**
 * The report out of what the container printed.
 *
 * The script prints one line of JSON and nothing else, but it runs inside an
 * image whose entrypoint has opinions, so the output can arrive with a line of
 * somebody else's before it. The last line that parses is the answer; anything
 * else is a run that did not produce one.
 */
export function readTrimReport(output: string): WorldTrimReport | null {
    for (const line of output.trim().split(/\r?\n/).reverse()) {
        const text = line.trim();
        if (!text.startsWith("{")) continue;
        let value: unknown;
        try {
            value = JSON.parse(text);
        } catch {
            continue;
        }
        if (typeof value !== "object" || value === null) continue;
        const row = value as Record<string, unknown>;
        if (typeof row.removed !== "number") continue;
        return {
            dryRun: row.dryRun === true,
            dimensions: numberOf(row.dimensions),
            regions: numberOf(row.regions),
            kept: numberOf(row.kept),
            removed: numberOf(row.removed),
            freedBytes: numberOf(row.freedBytes),
            skipped: Array.isArray(row.skipped)
                ? row.skipped.flatMap((entry) => {
                      if (typeof entry !== "object" || entry === null) return [];
                      const skip = entry as Record<string, unknown>;
                      return typeof skip.file === "string"
                          ? [{ file: skip.file, why: typeof skip.why === "string" ? skip.why : "" }]
                          : [];
                  })
                : [],
            backup:
                typeof row.backup === "object" &&
                row.backup !== null &&
                typeof (row.backup as Record<string, unknown>).name === "string"
                    ? {
                          name: (row.backup as Record<string, unknown>).name as string,
                          sizeBytes: numberOf((row.backup as Record<string, unknown>).sizeBytes)
                      }
                    : null,
            refused: row.refused === undefined || row.refused === null ? null : readRefusal(row.refused)
        };
    }
    return null;
}

function numberOf(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** What a run did, in one sentence, for the screen and for the activity trail. */
export function describeTrim(report: WorldTrimReport): string {
    if (report.refused) return describeRefusal(report.refused);
    if (report.removed === 0) return gameMessage("games", "lib.trim.nothing");
    const size = formatBytes(report.freedBytes);
    return report.dryRun
        ? gameMessage("games", "lib.trim.wouldFree", { count: report.removed, size })
        : gameMessage("games", "lib.trim.freed", { count: report.removed, size });
}

/** Why nothing was done, in words for whoever pressed the button. */
export function describeRefusal(refused: WorldTrimRefusal): string {
    switch (refused.reason) {
        case "share":
            return gameMessage("games", "lib.trim.refusedShare", {
                share: Math.round(refused.share * 100)
            });
        case "untracked":
            return gameMessage("games", "lib.trim.refusedUntracked");
        case "room":
            return gameMessage("games", "lib.trim.refusedRoom", {
                free: formatBytes(refused.free),
                size: formatBytes(refused.size)
            });
        case "backup":
            return gameMessage("games", "lib.trim.refusedBackup");
    }
}

/**
 * A past run the World screen should still ask about, or null.
 *
 * Any run that removed something and was not started from the button since
 * 2026-11-21 - which covers every automatic run, none of which took a backup -
 * until the operator says the world is fine (BUG-0009).
 */
export function pastTrimToReview(run: WorldTrimRun | null): WorldTrimRun | null {
    if (!run || !run.ok || run.removed <= 0) return null;
    if (run.trigger === "button" || run.acknowledged) return null;
    return run;
}
