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
import { NO_ROUTES_FILE } from "@polaris/core";
import { setTimeout as pause } from "node:timers/promises";
import { chmod, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";

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
 *
 * A file that already holds exactly `content` is left alone. Boot passes, the health
 * probe and every deploy republish whole files, and during an update two dashboards
 * do it at once; a rename the edge did not need is a reload it did not need, so only
 * a change ever reaches the directory. `force` writes it anyway: a repair for an edge
 * that never took the file it holds needs the rename to make it read it again.
 */
export async function writeDynamicFile(
    fileName: string,
    content: string,
    options: { mode?: number; force?: boolean } = {}
): Promise<void> {
    const target = dynamicPath(fileName);
    if (!options.force && (await readFile(target, "utf8").catch(() => null)) === content) {
        if (options.mode !== undefined) await chmod(target, options.mode).catch(() => undefined);
        return;
    }
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

/** A top-level section with nothing in it, which Traefik refuses as "a standalone element". */
const EMPTY_SECTION = /^(http|tcp|udp|tls):\s*\{\s*\}$/;

/** Whether a file holds nothing but empty sections (and comments), the shape
 *  earlier releases wrote for "no routes" and Traefik refuses. */
export function refusedEmptyFile(content: string): boolean {
    const lines = content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("#"));
    return lines.length > 0 && lines.every((line) => EMPTY_SECTION.test(line));
}

/**
 * Rewrite every routing file an earlier release left as `http: {}` to
 * `NO_ROUTES_FILE`. Traefik refuses that file, and one refused file stops the
 * edge applying any change in the directory - on 3.7 it loads none of it - so a
 * file nothing will render again (an uninstalled app's) cannot wait for its
 * writer. Returns the names it rewrote.
 */
export async function repairEmptySections(): Promise<string[]> {
    const names = await readdir(dynamicDir()).catch(() => [] as string[]);
    const repaired: string[] = [];
    for (const name of names) {
        if (!/\.ya?ml$/.test(name)) continue;
        const content = await readFile(dynamicPath(name), "utf8").catch(() => null);
        if (content === null || !refusedEmptyFile(content)) continue;
        await writeDynamicFile(name, NO_ROUTES_FILE);
        repaired.push(name);
    }
    return repaired;
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
