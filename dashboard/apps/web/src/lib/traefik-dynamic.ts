/**
 * Writing into Traefik's dynamic directory.
 *
 * The edge watches this directory and applies what it finds there, so a file in it is
 * read at a moment nothing here chooses. `writeFile` truncates before it writes: a
 * write that fails, or that is interrupted between the two, leaves a file of zero
 * bytes. For a routing file that is not a smaller config, it is no config - and a
 * zero-byte `polaris-apps.yml` is every deployed domain answering Traefik's own
 * `404 page not found` while the containers behind them are up and reachable on their
 * host ports. Found exactly that way on 2026-08-25, twelve hours after an update, with
 * nothing in any log to say what had happened.
 *
 * So content is written to a temporary name in the same directory and renamed over the
 * target. A rename within one filesystem is atomic, which makes the two failure modes
 * survivable: a reader sees either the previous file or the complete new one, and a
 * write that throws leaves the previous file serving.
 *
 * Traefik ignores the temporary file - its file provider reads only `.toml`, `.yaml`,
 * `.yml` and `.json` - so the window in which it exists cannot be observed by the edge.
 */

import { join } from "node:path";
import { rename, unlink, writeFile } from "node:fs/promises";

/** Traefik's file-provider directory, the volume the edge and the dashboard share. */
export function dynamicDir(): string {
    return process.env.POLARIS_TRAEFIK_DYNAMIC_DIR ?? "/dynamic";
}

/** Absolute path of a file in that directory. */
export function dynamicPath(fileName: string): string {
    return join(dynamicDir(), fileName);
}

/**
 * Write one file into the dynamic directory, atomically.
 *
 * `mode` is applied to the temporary file and carried over by the rename, so a key
 * written 0600 is never briefly readable under its final name.
 */
export async function writeDynamicFile(
    fileName: string,
    content: string,
    options: { mode?: number } = {}
): Promise<void> {
    const target = dynamicPath(fileName);
    const temp = `${target}.tmp`;
    try {
        await writeFile(temp, content, { encoding: "utf8", mode: options.mode });
        await rename(temp, target);
    } catch (error) {
        // A leftover temporary file would otherwise accumulate one per failure, and the
        // cleanup passes that sweep this directory match on their own prefixes.
        await unlink(temp).catch(() => undefined);
        throw error;
    }
}
