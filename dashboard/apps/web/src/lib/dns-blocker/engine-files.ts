/**
 * Lists Polaris writes into the DNS server's own volume - the operator's rules
 * and the domains Dymo flagged - and has it load again, with no redeploy.
 *
 * A redeploy is every device on the network without names until the server is
 * back, so what changes often is never in the rendered configuration: the
 * configuration names these files once, and a change is a file written and the
 * lists loaded again. A file whose content did not change is not written, and
 * nothing changed is no reload.
 */

import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { engineTarget, refreshLists } from "./insights";

/** The hash of what was last written to each file, per container. In memory:
 *  a restart writes each file once more. */
const written = new Map<string, string>();

/** Forget what was written, so the next write puts every file back: after a
 *  deploy, whose container may be new. */
export function forgetEngineFiles(): void {
    written.clear();
}

/** Which of `files` differ from what was last written. Pure but for the
 *  memory it reads; exported for tests. */
export function changedFiles(
    container: string,
    files: ReadonlyMap<string, string>
): [string, string, string][] {
    const changed: [string, string, string][] = [];
    for (const [path, text] of files) {
        const hash = createHash("sha256").update(text).digest("hex");
        if (written.get(`${container}:${path}`) !== hash) changed.push([path, text, hash]);
    }
    return changed;
}

/**
 * Write the files that changed into the DNS server and load its lists again
 * when any did. True when something was written. A runtime that cannot write
 * into a container writes nothing and says false.
 */
export async function writeEngineFiles(files: ReadonlyMap<string, string>): Promise<boolean> {
    const target = await engineTarget();
    if (!target.ports.writeFile) return false;
    const changed = changedFiles(target.container, files);
    for (const [path, text, hash] of changed) {
        const bytes = Buffer.from(text, "utf8");
        await target.ports.writeFile(target.container, path, Readable.from([bytes]), bytes.length);
        written.set(`${target.container}:${path}`, hash);
    }
    if (changed.length === 0) return false;
    await refreshLists();
    return true;
}
