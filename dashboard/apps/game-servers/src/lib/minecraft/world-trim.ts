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

export const WORLD_TRIM_DEFAULTS: WorldTrimSettings = {
    enabled: true,
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
}

/** The settings out of a stored config blob, with anything malformed falling back
 *  to the default rather than throwing: it is a blob written by an older version
 *  of this screen, and a bad entry must not take down the page that would fix it. */
export function readWorldTrim(config: Record<string, unknown>): WorldTrimSettings {
    const raw = config[WORLD_TRIM_KEY];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return WORLD_TRIM_DEFAULTS;
    const value = raw as Partial<Record<keyof WorldTrimSettings, unknown>>;
    return {
        // Absent means the default, which is on. A server that has never been near
        // this screen is exactly the one whose world has been growing untouched.
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
        detail: typeof value.detail === "string" ? value.detail : ""
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
                : []
        };
    }
    return null;
}

function numberOf(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** What a run did, in one sentence, for the screen and for the activity trail. */
export function describeTrim(report: WorldTrimReport): string {
    if (report.removed === 0) return "Nothing to take out - every chunk has been visited.";
    const chunks = report.removed === 1 ? "1 chunk" : `${report.removed.toLocaleString()} chunks`;
    const size = formatBytes(report.freedBytes);
    return report.dryRun
        ? `${chunks} have never been visited. Removing them would free ${size}.`
        : `Removed ${chunks} nobody had been in, freeing ${size}.`;
}
