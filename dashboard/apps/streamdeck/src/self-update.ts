/**
 * Updating now, for a plugin the install line put in.
 *
 * The install line leaves a job of the user's own that fetches and installs a
 * newer release every six hours (scripts/install.ps1, scripts/install.sh). A
 * plugin installed that way can ask that job to run right away instead of
 * sending its owner to download the file. One opened from a file has no job,
 * and keeps the Downloads notice.
 *
 * The job is started through the system's own scheduler rather than as a child
 * of this process: it closes the Stream Deck app to swap the plugin's folder,
 * which ends this process too, and the scheduler's run outlives it.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";

/** The task install.ps1 registers. */
const WINDOWS_TASK = "Polaris Stream Deck updates";
/** The launchd label install.sh registers. */
const MAC_JOB = "polaris-streamdeck-update";

/** Where the install line keeps its updater on this system; null where it has none. */
export function updaterPath(
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env
): string | null {
    if (platform === "win32") {
        const base = env.LOCALAPPDATA;
        return base ? join(base, "Polaris", "streamdeck", "update.ps1") : null;
    }
    if (platform === "darwin") {
        const home = env.HOME;
        return home
            ? join(home, "Library", "Application Support", "Polaris", "streamdeck", "update.sh")
            : null;
    }
    return null;
}

/** Whether this copy was put in by the install line, which can update it now. */
export function canUpdateNow(): boolean {
    const path = updaterPath();
    return path !== null && existsSync(path);
}

/** The program and arguments that start the job now. */
export function updateCommand(
    platform: NodeJS.Platform = process.platform,
    uid: number | null = typeof process.getuid === "function" ? process.getuid() : null
): { file: string; args: string[] } | null {
    if (platform === "win32") return { file: "schtasks.exe", args: ["/Run", "/TN", WINDOWS_TASK] };
    if (platform === "darwin" && uid !== null)
        return { file: "launchctl", args: ["kickstart", `gui/${uid}/${MAC_JOB}`] };
    return null;
}

/** Start the job. Resolves false when there is none or the scheduler refused. */
export function updateNow(): Promise<boolean> {
    const command = canUpdateNow() ? updateCommand() : null;
    if (!command) return Promise.resolve(false);
    return new Promise((resolve) => {
        execFile(command.file, command.args, { windowsHide: true, timeout: 15_000 }, (error) =>
            resolve(!error)
        );
    });
}

/** How long the job may run before it is stopped: install.ps1's ExecutionTimeLimit. */
export const UPDATE_RUN_MS = 15 * 60_000;

/** An "Update now" this copy started, and whether the scheduler took it. */
export type UpdateRun = { ok: boolean; at: number } | null;

/** Where that run stands: a job that outlives its time limit and has not swapped
 *  the plugin (which would have closed this copy) did not update it. */
export function updateState(
    run: UpdateRun,
    now: number = Date.now()
): "idle" | "started" | "failed" {
    if (!run) return "idle";
    if (!run.ok || now - run.at >= UPDATE_RUN_MS) return "failed";
    return "started";
}
