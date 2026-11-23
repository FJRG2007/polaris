/**
 * What the launcher's rows were chosen for, on this computer: one small file
 * of frecency records (`@polaris/core` `frecency`, the ranking every surface
 * shares), read once and written on each choice. Nothing runs on a timer; a
 * record decays by arithmetic when it is ranked, not by a sweep.
 *
 * Kept on the computer rather than on the account: most keys are this
 * machine's own (a program's path), and a choice must never wait on the network.
 */

import { join } from "node:path";
import { app } from "electron";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { frecencyByKey, readUseRecords, recordUse, type UseRecord } from "../../../dashboard/packages/core/src/frecency";

let records: UseRecord[] | null = null;

function file(): string {
    return join(app.getPath("userData"), "launcher-usage.json");
}

function loaded(): UseRecord[] {
    if (records) return records;
    try {
        records = readUseRecords(JSON.parse(readFileSync(file(), "utf8")));
    } catch {
        // Missing or unreadable: start over rather than fail the launcher.
        records = [];
    }
    return records;
}

/** Each row key's score now. */
export function usageScores(now = Date.now()): Map<string, number> {
    return frecencyByKey(loaded(), now);
}

/** One more use of `key`, saved by a write to a temporary file renamed over the last. */
export function recordLauncherUse(key: string, now = Date.now()): void {
    records = recordUse(loaded(), key, now);
    const path = file();
    const temp = `${path}.${process.pid}.${now}.tmp`;
    try {
        writeFileSync(temp, JSON.stringify(records), { mode: 0o600 });
        renameSync(temp, path);
    } catch {
        // The ranking is a convenience: a failed write keeps it in memory only.
        rmSync(temp, { force: true });
    }
}
