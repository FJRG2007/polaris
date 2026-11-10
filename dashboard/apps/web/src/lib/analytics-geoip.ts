/**
 * The country a visit came from, read off its address with a database kept on this
 * server - so the map fills in for every site, including the ones counted only from
 * the edge log, and no visitor's address is ever sent anywhere to be looked up.
 *
 * The database is DB-IP's "IP to Country Lite" (CC BY 4.0, monthly; the screens
 * that show its answers credit it). Polaris fetches it on its own the first time a
 * visit needs it and again when it is a month old, into the data folder, so there
 * is nothing to install and nothing to configure. Until the first copy has arrived
 * - or on a server that cannot reach the internet - a visit falls back to the time
 * zone the tracker reports, exactly as before.
 *
 * Lookups are synchronous and in memory (a binary tree walk over a ~7 MB buffer),
 * so recording a visit never waits on a disk or a network.
 */

import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { loadEnv } from "@polaris/config";
import { Reader, type CountryResponse } from "mmdb-lib";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";

/** Where the copy lives, under the data folder every install already has. */
function databasePath(): string {
    return join(loadEnv().POLARIS_DATA_DIR, "geo", "dbip-country-lite.mmdb");
}

/** A month and a few days: DB-IP publishes at the start of each month. */
const REFRESH_AFTER_MS = 35 * 86_400_000;
/** After a failed fetch, how long before trying again. Visits keep flowing meanwhile. */
const RETRY_AFTER_MS = 60 * 60_000;
/** The compressed file is a few MB; anything far larger is not the file asked for. */
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** The file for a given month, `https://download.db-ip.com/free/dbip-country-lite-YYYY-MM.mmdb.gz`. */
export function downloadUrl(at: Date): string {
    const month = String(at.getUTCMonth() + 1).padStart(2, "0");
    return `https://download.db-ip.com/free/dbip-country-lite-${at.getUTCFullYear()}-${month}.mmdb.gz`;
}

/** The month before, for the first days of a month when the new file is not out yet. */
function previousMonth(at: Date): Date {
    return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 1, 1));
}

let reader: Reader<CountryResponse> | null = null;
let loadedAt = 0;
let pending: Promise<void> | null = null;
let failedAt = 0;

/** Read a copy into memory, if there is one and it opens. */
async function loadFromDisk(): Promise<number | null> {
    try {
        const path = databasePath();
        const [buffer, info] = await Promise.all([readFile(path), stat(path)]);
        reader = new Reader<CountryResponse>(buffer);
        loadedAt = Date.now();
        return info.mtimeMs;
    } catch {
        return null;
    }
}

async function download(now: Date): Promise<Buffer> {
    for (const month of [now, previousMonth(now)]) {
        const response = await fetch(downloadUrl(month), {
            signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
            headers: { "User-Agent": "Polaris" }
        });
        if (response.status === 404) continue;
        if (!response.ok) throw new Error(`geo database answered ${response.status}`);
        const length = Number(response.headers.get("content-length") ?? 0);
        if (length > MAX_DOWNLOAD_BYTES) throw new Error("geo database is larger than expected");
        const packed = Buffer.from(await response.arrayBuffer());
        if (packed.length > MAX_DOWNLOAD_BYTES) throw new Error("geo database is larger than expected");
        return gunzipSync(packed, { maxOutputLength: MAX_DOWNLOAD_BYTES * 4 });
    }
    throw new Error("no geo database published for this month or the last");
}

/**
 * Fetch a fresh copy and swap it in. Written beside the old one and renamed over it,
 * so an interrupted download never leaves a half file that the next start would read.
 */
async function refresh(): Promise<void> {
    const raw = await download(new Date());
    // Opening it is the check that it is a database and not an error page.
    const fresh = new Reader<CountryResponse>(raw);
    const path = databasePath();
    await mkdir(join(path, ".."), { recursive: true });
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
        await writeFile(temp, raw);
        await rename(temp, path);
    } catch (error) {
        await unlink(temp).catch(() => undefined);
        throw error;
    }
    reader = fresh;
    loadedAt = Date.now();
}

/**
 * Make sure a copy is loaded and current. Never throws and never runs twice at once;
 * a failure waits an hour before the next attempt.
 */
export function ensureGeoDatabase(): Promise<void> {
    if (pending) return pending;
    const now = Date.now();
    if (reader && now - loadedAt < REFRESH_AFTER_MS) return Promise.resolve();
    if (failedAt && now - failedAt < RETRY_AFTER_MS) return Promise.resolve();
    pending = (async () => {
        try {
            const written = reader ? null : await loadFromDisk();
            const age = written === null ? (reader ? now - loadedAt : Infinity) : now - written;
            if (age < REFRESH_AFTER_MS) {
                // A copy from disk counts from when it was written, not from this start.
                loadedAt = now - age;
                return;
            }
            await refresh();
            failedAt = 0;
        } catch (error) {
            failedAt = Date.now();
            // An old copy stays in use, but counts as due so the next try comes after
            // the retry wait rather than a month from now.
            if (reader) loadedAt = failedAt - REFRESH_AFTER_MS;
            console.error("polaris: the analytics geo database could not be fetched:", error instanceof Error ? error.message : error);
        } finally {
            pending = null;
        }
    })();
    return pending;
}

/**
 * The ISO 3166-1 alpha-2 country of an address, or null when it is private, unknown,
 * or the database has not arrived yet (in which case fetching it starts now).
 */
export function countryForIp(ip: string | null | undefined): string | null {
    if (!ip) return null;
    void ensureGeoDatabase();
    if (!reader) return null;
    try {
        const code = reader.get(ip)?.country?.iso_code;
        return code && /^[A-Z]{2}$/.test(code) ? code : null;
    } catch {
        // Not an address the reader can parse.
        return null;
    }
}

/** Whether a copy is loaded - the backfill waits for it rather than guessing. */
export function geoDatabaseReady(): boolean {
    return reader !== null;
}

/** For tests: forget the loaded copy and any failure. */
export function resetGeoDatabaseForTests(next: Reader<CountryResponse> | null = null): void {
    reader = next;
    loadedAt = next ? Date.now() : 0;
    pending = null;
    failedAt = 0;
}
