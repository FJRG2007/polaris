/**
 * Starting an update.
 *
 * The dashboard cannot update itself from inside the container it is about to
 * replace, so it asks the host agent to run the updater instead. Two callers want
 * that: the button in Settings, and the watcher that installs on a schedule -
 * which is why it lives here rather than inside the server action, where a
 * background loop could not reach it.
 *
 * Nothing throws. Every way this can fail is a state the caller has to render or
 * report anyway, so they come back as outcomes.
 */

import type { UpdateSource } from "@polaris/core";
import { HostdClient } from "@polaris/hostd-client";
import { open, stat, writeFile } from "node:fs/promises";

/** Where hostd streams the updater's output, on the shared polaris-run volume. */
export const UPDATE_LOG_PATH = process.env.POLARIS_UPDATE_LOG ?? "/run/polaris/update.log";

/**
 * Where the updater reads the kind of update to run, on the same shared volume.
 *
 * The update command is a fixed string in the host's environment - the dashboard
 * cannot pass it arguments, and it should not be able to: whatever it could pass
 * would run as root on the host. A one-word file it may write instead is the
 * whole of the influence it has, and the updater accepts only the two words it
 * knows, so the worst a compromised dashboard can ask for is the other kind of
 * update.
 */
export const UPDATE_SOURCE_PATH = process.env.POLARIS_UPDATE_SOURCE_FILE ?? "/run/polaris/update.source";

/**
 * Tell the host which kind of update to run next. Best-effort: a deployment with
 * no shared volume (a dev run, the limited edition) has no updater to tell, and
 * the updater falls back to the published image when the file is not there -
 * which is also what it should do.
 */
export async function publishUpdateSource(source: UpdateSource): Promise<void> {
    await writeFile(UPDATE_SOURCE_PATH, `${source}\n`, "utf8").catch(() => undefined);
}

/** The marker the updater appends when it exits. */
const EXIT_MARKER = /POLARIS_UPDATE_EXIT=(-?\d+)/;

/** Result of asking the host agent to update and redeploy Polaris. */
export type UpdateTrigger = "started" | "unavailable" | "disabled" | "unreachable";

/**
 * Ask the host agent (hostd) to pull the latest image and redeploy. Degrades to
 * "unreachable" when no agent is running and "unavailable" when it has no update
 * command configured, so the caller can fall back to the manual instruction.
 */
export async function startHostUpdate(): Promise<UpdateTrigger> {
    try {
        const client = new HostdClient();
        if (!(await client.health())) return "unreachable";
        return await client.update();
    } catch {
        return "unreachable";
    }
}

/** How a run on this host ended, as far as its log can say. */
export interface UpdateOutcome {
    /** The code the updater reported, or null when it has not reported one -
     *  which means the run is still going or was cut off, not that it passed. */
    readonly exitCode: number | null;
    /** Last write to the log, epoch ms. */
    readonly endedAt: number;
}

/**
 * How the last update run ended, read from the log the updater writes. Null when
 * there is no log to read - a host that streams nothing, or one where no update
 * has ever run - which is not the same as a run that went well.
 *
 * Only the tail is read: the marker is the last thing written, and the rest of a
 * build log has no business in memory here.
 */
export async function lastUpdateOutcome(): Promise<UpdateOutcome | null> {
    const info = await stat(UPDATE_LOG_PATH).catch(() => null);
    if (!info?.isFile()) return null;
    const handle = await open(UPDATE_LOG_PATH, "r").catch(() => null);
    if (!handle) return null;
    try {
        const start = Math.max(0, info.size - 128);
        const length = info.size - start;
        if (length <= 0) return { exitCode: null, endedAt: info.mtimeMs };
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, start);
        const match = EXIT_MARKER.exec(buffer.toString("utf8"));
        return { exitCode: match ? Number(match[1]) : null, endedAt: info.mtimeMs };
    } finally {
        await handle.close();
    }
}

/** Why an update did not start, in words an operator can act on. */
export function updateTriggerReason(trigger: Exclude<UpdateTrigger, "started">): string {
    if (trigger === "unavailable") return "The host agent has no update command set.";
    if (trigger === "disabled") return "Updates are switched off on this host.";
    return "The host agent could not be reached.";
}
