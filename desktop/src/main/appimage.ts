/**
 * Replacing a running AppImage with a newer one, the way the AppImage itself
 * cannot be told to.
 *
 * The new file is written beside the old one under a name of its own, checked
 * against the size and SHA-256 the release publishes, made executable and only
 * then renamed over the old one. A rename in one directory is atomic, so the
 * path holds the old AppImage or the new one and never a part of either; the
 * running copy keeps its own mounted file until it quits. Any failure removes
 * the new file and leaves the old one where it was.
 *
 * Free of Electron so the tests can run it against files of their own.
 */

import { basename, dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { chmod, open, rename, rm } from "node:fs/promises";

export interface Expected {
    readonly size: number;
    /** Lowercase hex. */
    readonly sha256: string;
}

/** Downloads `url` and puts it at `target` once it matches `expected`. Throws,
 *  with `target` untouched, when it does not or anything fails on the way. */
export async function replaceAppImage(
    target: string,
    url: string,
    expected: Expected,
    fetch: (url: string, init: { signal: AbortSignal; }) => Promise<Response>,
    signal: AbortSignal = AbortSignal.timeout(30 * 60_000)
): Promise<void> {
    const temporary = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString("hex")}.update`);
    const file = await open(temporary, "wx", 0o600);
    let closed = false;
    try {
        const response = await fetch(url, { signal });
        if (!response.ok || !response.body) throw new Error(`Download answered ${response.status}`);
        const hash = createHash("sha256");
        let size = 0;
        const reader = response.body.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > expected.size) {
                await reader.cancel();
                throw new Error("The download is larger than the release says");
            }
            hash.update(value);
            await file.write(value);
        }
        if (size !== expected.size) throw new Error("The download is smaller than the release says");
        if (hash.digest("hex") !== expected.sha256) throw new Error("The download does not match its checksum");
        await file.sync();
        await file.close();
        closed = true;
        await chmod(temporary, 0o755);
        await rename(temporary, target);
    } catch (error) {
        if (!closed) await file.close().catch(() => undefined);
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
    }
}
