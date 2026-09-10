/**
 * A folder on this computer, zipped the way the dashboard's "Upload a folder"
 * expects it: every entry under the folder's own name, `node_modules` and `.git`
 * left out (see `zip-rules`).
 *
 * Done here rather than in the page because a folder picked in the browser is
 * enumerated file by file before anything can be skipped - a project with a
 * `node_modules` is a hundred thousand files read only to be thrown away. Walking
 * it from here prunes those folders without opening them.
 *
 * A link is followed only when it leads to somewhere inside the picked folder.
 * The zip is sent to a server, and a link inside a project to somewhere else on
 * the disk would send that too. Followed at all because Windows reports a file
 * OneDrive keeps online-only as a link, and a project in a synced Documents
 * folder would otherwise arrive with files missing. A link back into a folder
 * it sits in, or to a folder already walked through a link, is skipped, so a
 * loop of links ends.
 */

import { Zip, ZipDeflate } from "fflate";
import { createReadStream } from "node:fs";
import { basename, join, sep } from "node:path";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import {
    EMPTY_FOLDER,
    FOLDER_TOO_LARGE,
    MAX_FOLDER,
    MAX_ZIP,
    ZIP_TOO_LARGE,
    skipped
} from "./zip-rules";

/** A refusal whose message is written for the person who picked the folder. */
export class FolderRefusal extends Error {}

export interface FolderEntry {
    /** Inside the zip: `folder/src/index.ts`. */
    readonly path: string;
    readonly file: string;
    readonly size: number;
    readonly mtime: Date;
}

export interface ZippedFolder {
    readonly name: string;
    readonly files: number;
    readonly zip: Uint8Array;
}

/** Whether a real path is `folder` or somewhere under it. */
function inside(path: string, folder: string): boolean {
    return path === folder || path.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`);
}

/** Every file that goes into the zip, refusing a folder that holds too much. */
export async function listFolder(root: string): Promise<FolderEntry[]> {
    const name = basename(root);
    const entries: FolderEntry[] = [];
    let total = 0;
    const top = await realpath(root);
    const linkedFolders = new Set<string>();

    /** `chain` holds the real path of every folder on the way down, `dir`'s last. */
    async function walk(dir: string, prefix: string, chain: readonly string[]): Promise<void> {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const path = `${prefix}/${entry.name}`;
            if (skipped(path)) continue;
            const file = join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(file, path, [...chain, join(chain.at(-1) ?? top, entry.name)]);
            } else if (entry.isFile()) {
                add(path, file, await lstat(file));
            } else if (entry.isSymbolicLink()) {
                const target = await realpath(file).catch(() => null);
                if (!target || !inside(target, top)) continue;
                const info = await stat(target);
                if (info.isFile()) {
                    add(path, target, info);
                } else if (info.isDirectory()) {
                    if (linkedFolders.has(target) || chain.some((folder) => inside(folder, target)))
                        continue;
                    linkedFolders.add(target);
                    await walk(target, path, [...chain, target]);
                }
            }
        }
    }

    function add(
        path: string,
        file: string,
        info: { readonly size: number; readonly mtime: Date }
    ): void {
        total += info.size;
        if (total > MAX_FOLDER) throw new FolderRefusal(FOLDER_TOO_LARGE);
        entries.push({ path, file, size: info.size, mtime: info.mtime });
    }

    if (skipped(name)) throw new FolderRefusal(EMPTY_FOLDER);
    await walk(root, name, [top]);
    if (entries.length === 0) throw new FolderRefusal(EMPTY_FOLDER);
    return entries;
}

/** The files, deflated into one zip held in memory - never more than `MAX_ZIP`. */
export async function zipEntries(entries: readonly FolderEntry[]): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let failure: Error | null = null;
    let finished = false;
    const zip = new Zip((error, chunk, final) => {
        if (error) failure = error;
        if (failure) return;
        size += chunk.length;
        if (size > MAX_ZIP) {
            failure = new FolderRefusal(ZIP_TOO_LARGE);
            return;
        }
        chunks.push(chunk);
        if (final) finished = true;
    });

    for (const entry of entries) {
        const file = new ZipDeflate(entry.path, { level: 6 });
        file.mtime = entry.mtime;
        zip.add(file);
        for await (const chunk of createReadStream(entry.file)) {
            file.push(chunk as Buffer, false);
            if (failure) break;
        }
        if (failure) break;
        file.push(new Uint8Array(0), true);
    }
    if (failure) {
        zip.terminate();
        throw failure;
    }
    zip.end();
    if (failure) throw failure;
    if (!finished) throw new Error("The zip did not finish");

    const out = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
    }
    return out;
}

/** A picked folder, zipped. */
export async function zipFolder(root: string): Promise<ZippedFolder> {
    const entries = await listFolder(root);
    return { name: basename(root), files: entries.length, zip: await zipEntries(entries) };
}
