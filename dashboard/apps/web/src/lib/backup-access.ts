/**
 * Whether backup access is serving the domain right now, and whether the heavy
 * background work should hold back while it does.
 *
 * The seam other features read. While backup access owns the domain's records the
 * public-address follower (`domain-address-sync`) stands back so the two never
 * write the same record; it owns them from the moment it saved the originals
 * until it has written them back, so a restart in between still counts.
 *
 * Read from stored settings, cached for a few seconds: these are asked on every
 * tick of several pollers.
 */

import { getSetting } from "@/lib/setting-store";

export const BACKUP_STATE_KEY = "backupAccess.state";
export const BACKUP_CONFIG_KEY = "backupAccess.config";
export const BACKUP_RECORDS_KEY = "backupAccess.records";

const CACHE_MS = 10_000;
let cached: { at: number; active: boolean; saver: boolean } | null = null;

async function read(): Promise<{ active: boolean; saver: boolean }> {
    if (cached && Date.now() - cached.at < CACHE_MS) return cached;
    const [state, config, records] = await Promise.all([
        getSetting(BACKUP_STATE_KEY).catch(() => null),
        getSetting(BACKUP_CONFIG_KEY).catch(() => null),
        getSetting(BACKUP_RECORDS_KEY).catch(() => null)
    ]);
    const serving = field(state, "serving") === "backup";
    const active = serving || Boolean(records);
    cached = { at: Date.now(), active, saver: active && field(config, "dataSaver") !== false };
    return cached;
}

function field(raw: string | null, key: string): unknown {
    if (!raw) return undefined;
    try {
        return (JSON.parse(raw) as Record<string, unknown>)[key];
    } catch {
        return undefined;
    }
}

/** Forget the cached answer: the service calls it right after a flip. */
export function forgetBackupAccess(): void {
    cached = null;
}

export async function backupAccessActive(): Promise<boolean> {
    return (await read()).active;
}

/**
 * The data-saver flag: on while the domain is served over the backup path, unless
 * the operator turned it off. Anything that moves a lot of data in the background
 * (image pulls, update checks, scheduled backups, camera and stream quality) asks
 * this and holds back while it is true.
 */
export async function dataSaverActive(): Promise<boolean> {
    return (await read()).saver;
}
