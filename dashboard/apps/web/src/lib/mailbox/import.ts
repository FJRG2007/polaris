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

/** What an import is aimed at. */
export interface ImportTarget {
    readonly accountId: string;
    readonly folderId: string;
    /** The upload holding the archive. */
    readonly uploadId: string;
}

/** Read the archive and say what is in it. */
async function messagesIn(userId: string, uploadId: string): Promise<string[]> {
    const file = await readUpload(userId, uploadId);
    if (!file) return [];
    // Both shapes go through the same reader: an `.eml` is a file with no
    // separator in it, which `readMbox` answers with the one message it plainly
    // contains rather than with nothing.
    return core.readMbox(file.bytes.toString("utf8"));
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
    const slice = all.slice(Math.max(0, from), Math.max(0, from) + IMPORT_BATCH);
    if (slice.length === 0) {
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

    return { done, failed, next: Math.max(0, from) + slice.length, total: all.length };
}
