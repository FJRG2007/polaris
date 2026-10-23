/**
 * What each server said about itself, kept on disk.
 *
 * The local addresses are learned over the server's own address once its key is
 * accepted. Held only in memory, an app started while the internet is down would
 * have none, which is exactly the day they are needed. So the record - the id,
 * the public key and the addresses, none of them secret - is written beside the
 * settings and read back on the first call. An alternate is still used only after
 * it signs a fresh challenge with that key, so a tampered file can at worst cost
 * the fallback, never send the key somewhere else.
 *
 * The file path is a parameter so this stays testable without Electron.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { readInstance, type InstanceRecord } from "../../../dashboard/packages/core/src/instance-fallback";

export interface StoredInstance {
    readonly record: InstanceRecord;
    readonly learnedAt: number;
}

/** How long a stored record is trusted before it is learned again over the server's own address. */
export const RELEARN_MS = 24 * 60 * 60_000;

/** Every stored record, keyed by server origin. Anything malformed is left out. */
export function readInstances(file: string): Map<string, StoredInstance> {
    const held = new Map<string, StoredInstance>();
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
        return held;
    }
    if (typeof raw !== "object" || raw === null) return held;
    for (const [server, value] of Object.entries(raw as Record<string, unknown>)) {
        const entry = (value ?? {}) as { record?: unknown; learnedAt?: unknown; };
        const record = readInstance(entry.record);
        const learnedAt = typeof entry.learnedAt === "number" ? entry.learnedAt : 0;
        if (record) held.set(server, { record, learnedAt });
    }
    return held;
}

/** The record for one server, or null. */
export function readStoredInstance(file: string, server: string): StoredInstance | null {
    return readInstances(file).get(server) ?? null;
}

/** Keep the record for one server, replacing what was there. Written atomically. */
export function writeStoredInstance(file: string, server: string, record: InstanceRecord, now = Date.now()): void {
    const all = Object.fromEntries(readInstances(file));
    all[server] = { record, learnedAt: now };
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(all, null, 4), { mode: 0o600 });
    renameSync(temp, file);
}
