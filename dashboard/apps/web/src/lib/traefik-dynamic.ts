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
 *
 * The temporary name is unique per write, because nothing serialises the callers: the
 * deploy pipeline, the tunnel service, the firewall actions, the boot pass and the
 * health poller's repair all write the app routes, and two of them sharing one
 * temporary name is two sets of bytes landing in one file and the mixture being renamed
 * over the live config - the corruption this whole module exists to prevent.
 */

import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { rename, unlink, writeFile } from "node:fs/promises";

/**
 * How many times a rename that was refused is tried again, and how long it waits
 * between attempts.
 *
 * Two writers landing on one file at the same moment is the ordinary case here -
 * five callers write the app routes and nothing serialises them - and on a
 * filesystem where a rename onto a path something else is holding is refused
 * rather than serialised, one of the two gives out with EPERM. The write itself
 * was fine; the moment was taken. Waiting a few milliseconds and asking again is
 * what makes the outcome the same everywhere: whichever renamed last is the file,
 * and neither caller is told its routes did not land when they did.
 *
 * Bounded, and only for the codes that mean "not now". A rename refused for any
 * other reason is a real failure and is raised as one.
 */
const RENAME_ATTEMPTS = 5;
const RENAME_PAUSE_MS = 20;
const BUSY = new Set(["EPERM", "EACCES", "EBUSY"]);

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
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
        await writeFile(temp, content, { encoding: "utf8", mode: options.mode });
        await renameOver(temp, target);
    } catch (error) {
        // A leftover temporary file would otherwise accumulate one per failure, and the
        // cleanup passes that sweep this directory match on their own prefixes, which
        // the unique name keeps.
        await unlink(temp).catch(() => undefined);
        throw error;
    }
}

/** Rename over the target, waiting out a filesystem that refuses one racing
 *  rename rather than serialising it. See RENAME_ATTEMPTS. */
async function renameOver(temp: string, target: string): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
        try {
            await rename(temp, target);
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code ?? "";
            if (attempt >= RENAME_ATTEMPTS || !BUSY.has(code)) throw error;
            await pause(RENAME_PAUSE_MS * attempt);
        }
    }
}
