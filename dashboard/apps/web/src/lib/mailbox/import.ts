/**
 * Bringing an archive into a mailbox.
 *
 * Somebody leaving a provider exports an `.mbox` or a folder of `.eml` files and
 * has nowhere to put them. Every other client answers this and Polaris did not,
 * which meant a newly connected mailbox showed what its own server held and
 * nothing else.
 *
 * **The messages go to the mail server, not into this database.** Each one is
 * appended to a real IMAP folder, so it is there on the phone and in whatever
 * else the person uses, and it survives Polaris being reinstalled. Writing them
 * into Polaris' own cache instead would produce an archive that exists in
 * exactly one client and disappears with it, which is not an import - it is a
 * second copy in a worse place.
 *
 * **It runs in batches, driven by the screen.** An mbox of four thousand
 * messages is four thousand appends over one connection, which is minutes: far
 * too long for a request, and the sort of thing that fails at message three
 * thousand with nothing to show for it. So the file is opened once to count what
 * is in it, and the screen then asks for a slice at a time and draws the
 * progress. A batch that fails leaves everything before it imported and says
 * where it stopped, and asking again from there is the whole recovery.
 *
 * Nothing is ever de-duplicated against what is already in the folder. That is
 * deliberate: matching on Message-Id would silently drop messages a server
 * rewrote, and importing the same file twice is a mistake somebody can see and
 * undo, while a message quietly missing from an archive is one they cannot.
 */

import { withImap } from "./imap";
import * as core from "@polaris/core";
import { readUpload } from "./uploads";
import { ownedAccount, ownedFolder } from "./access";

/** How many messages one batch appends. Small enough that a batch is seconds
 *  rather than minutes, big enough that the connection is worth opening. */
export const IMPORT_BATCH = 25;

/**
 * The archives currently being read, parsed once each.
 *
 * An import is one open and then a batch per twenty-five messages, and every one
 * of those used to read the whole file back out of storage, decode it and split
 * it again to take the next slice - four thousand messages meant a hundred and
 * sixty passes over the same megabytes, which is quadratic in the size of the
 * archive somebody is waiting on.
 *
 * So it is parsed on the open and kept until the last batch lands. Held per
 * reader as well as per upload, because the read it replaces was narrowed by the
 * owner and this must be too.
 */
const ARCHIVES = new Map<string, { messages: string[]; at: number }>();

/** How long a parsed archive outlives its last batch. Long enough for a slow
 *  import to finish, short enough that an abandoned one is not held for the life
 *  of the process. */
const ARCHIVE_TTL_MS = 30 * 60 * 1000;

/** How many are held at once. An archive is megabytes; two people importing at
 *  the same time is ordinary, ten is somebody filling the memory. */
const ARCHIVES_HELD = 4;

function archiveKey(userId: string, uploadId: string): string {
    return `${userId}:${uploadId}`;
}

/** Anything expired, and the oldest beyond what is held. Swept on the way in
 *  rather than on a timer: nothing here is worth a process-wide interval. */
function sweepArchives(): void {
    const now = Date.now();
    for (const [key, held] of ARCHIVES) {
        if (now - held.at > ARCHIVE_TTL_MS) ARCHIVES.delete(key);
    }
    while (ARCHIVES.size > ARCHIVES_HELD) {
        const oldest = [...ARCHIVES.entries()].sort((left, right) => left[1].at - right[1].at)[0];
        if (!oldest) break;
        ARCHIVES.delete(oldest[0]);
    }
}

/** Let one go, once its import has finished or failed. */
function forgetArchive(userId: string, uploadId: string): void {
    ARCHIVES.delete(archiveKey(userId, uploadId));
}

/** What an import is aimed at. */
export interface ImportTarget {
    readonly accountId: string;
    readonly folderId: string;
    /** The upload holding the archive. */
    readonly uploadId: string;
}

/** Read the archive and say what is in it, once per import. */
async function messagesIn(userId: string, uploadId: string): Promise<string[]> {
    sweepArchives();
    const key = archiveKey(userId, uploadId);
    const held = ARCHIVES.get(key);
    if (held) {
        held.at = Date.now();
        return held.messages;
    }

    const file = await readUpload(userId, uploadId);
    if (!file) return [];
    // Both shapes go through the same reader: an `.eml` is a file with no
    // separator in it, which `readMbox` answers with the one message it plainly
    // contains rather than with nothing.
    const messages = core.readMbox(file.bytes.toString("utf8"));
    ARCHIVES.set(key, { messages, at: Date.now() });
    return messages;
}

/**
 * How many messages the archive holds, checked against a mailbox and a folder
 * this person actually has.
 *
 * Both are resolved here rather than trusted, and both are narrowed by the
 * caller's own id inside their queries - a folder id in a request is a request.
 */
export async function openImport(
    userId: string,
    target: ImportTarget
): Promise<{ count: number; folder: string }> {
    await ownedAccount(userId, target.accountId);
    const folder = await ownedFolder(userId, target.folderId);
    if (folder.accountId !== target.accountId) {
        throw new Error("That folder is not in that mailbox.");
    }
    return { count: (await messagesIn(userId, target.uploadId)).length, folder: folder.path };
}

/**
 * Append one slice, and say how far it got.
 *
 * `\Seen` on everything, because an import of four thousand messages that
 * arrives as four thousand unread is an inbox somebody abandons. They are
 * somebody's archive, not their new mail.
 *
 * A message the server refuses is counted and skipped rather than failing the
 * batch: one malformed message in an export from a decade ago must not be the
 * reason the other three thousand nine hundred do not arrive.
 */
export async function importBatch(
    userId: string,
    target: ImportTarget,
    from: number
): Promise<{ done: number; failed: number; next: number; total: number }> {
    const account = await ownedAccount(userId, target.accountId);
    const folder = await ownedFolder(userId, target.folderId);
    if (folder.accountId !== target.accountId) {
        throw new Error("That folder is not in that mailbox.");
    }

    const all = await messagesIn(userId, target.uploadId);
    // Floored here as well as validated at the edge: a slice taken from `NaN` is
    // empty, and an empty slice reports the import as finished.
    const at = Number.isFinite(from) ? Math.max(0, Math.floor(from)) : 0;
    const slice = all.slice(at, at + IMPORT_BATCH);
    if (slice.length === 0) {
        forgetArchive(userId, target.uploadId);
        return { done: 0, failed: 0, next: all.length, total: all.length };
    }

    let done = 0;
    let failed = 0;
    await withImap(account, async (client) => {
        for (const raw of slice) {
            try {
                await client.append(folder.path, Buffer.from(raw, "utf8"), ["\\Seen"]);
                done += 1;
            } catch {
                // A message the server would not take. Counted, so the screen can
                // say how many did not make it, and skipped, so the rest do.
                failed += 1;
            }
        }
    });

    const next = at + slice.length;
    // The last slice, so the parsed archive is let go rather than waiting for
    // its half hour.
    if (next >= all.length) forgetArchive(userId, target.uploadId);
    return { done, failed, next, total: all.length };
}
