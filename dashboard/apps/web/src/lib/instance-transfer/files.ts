/**
 * Where transfer files wait: an export between being written and being
 * downloaded, an upload between arriving and being imported.
 *
 * Named by a random id, which is the only thing a caller can refer to one by, so
 * a path is never taken from a request. Anything older than an hour is gone the
 * next time a file is written here.
 */

import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadEnv } from "@polaris/config";
import { mkdir, readdir, rm, stat } from "node:fs/promises";

const MAX_AGE_MS = 60 * 60_000;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function dir(): string {
    return join(loadEnv().POLARIS_DATA_DIR, "transfers");
}

/** The path of a transfer file, or null for an id that is not one. */
export function transferPath(id: string): string | null {
    return ID.test(id) ? join(dir(), `${id}.polaris`) : null;
}

/** A fresh place to write a transfer file, clearing out stale ones first. */
export async function newTransferFile(): Promise<{ id: string; path: string }> {
    await mkdir(dir(), { recursive: true });
    const now = Date.now();
    for (const name of await readdir(dir()).catch(() => [] as string[])) {
        const path = join(dir(), name);
        const info = await stat(path).catch(() => null);
        if (info && now - info.mtimeMs > MAX_AGE_MS) await rm(path, { force: true }).catch(() => undefined);
    }
    const id = randomUUID();
    return { id, path: join(dir(), `${id}.polaris`) };
}

/** Remove a transfer file once it has been used. */
export async function dropTransferFile(id: string): Promise<void> {
    const path = transferPath(id);
    if (path) await rm(path, { force: true }).catch(() => undefined);
}
