/**
 * A message deleted while a sync pass has the folder open stays deleted.
 *
 * Reported on 2026-11-16 for an IONOS mailbox: mail received and deleted the day
 * before was back in the inbox. The live database ruled out the server keeping
 * it (no row carries `\Deleted`, no message is held in the inbox and the trash
 * at once, every trash note's message is in the trash), so the move itself
 * worked. What remains is the pass: it holds the inbox open on its own
 * connection for minutes, the delete runs on another one, and a server does not
 * tell a session about an expunge in the middle of a sequence FETCH (RFC 3501
 * 7.4.1). The window the pass lists still has the uid, its row is gone, and the
 * refill stored it again.
 *
 * Reproduced against a fake server whose sessions keep their own view until
 * they are told, as RFC 3501 requires.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { missingFromWindow } from "@/lib/mailbox/folder-window";
import {
    forgetRemoved,
    REMOVED_KEEP_MS,
    REMOVED_PER_FOLDER,
    rememberRemoved,
    removedFrom,
    withoutRemoved
} from "@/lib/mailbox/removed-uids";

/** One mailbox, two connections to it. */
class FakeServer {
    private uids: number[] = [];

    private next = 1;

    public deliver(count: number): void {
        for (let at = 0; at < count; at += 1) this.uids.push(this.next++);
    }

    /** A session's view: a copy of the uid list, refreshed only when the server
     *  is allowed to send it the expunges it owes. */
    public session() {
        let view = [...this.uids];
        return {
            /** A sequence FETCH: no expunge may be reported during it. */
            fetchSequence: (from: number, to: number) => view.slice(from - 1, to),
            /** A UID command or NOOP: what it owes is reported. */
            noop: () => {
                view = [...this.uids];
            },
            /** UID MOVE out of this mailbox. */
            move: (uid: number) => {
                this.uids = this.uids.filter((one) => one !== uid);
                view = [...this.uids];
                return true;
            }
        };
    }
}

const INBOX = "inbox-folder";

describe("a deleted message the pass still sees", () => {
    beforeEach(() => forgetRemoved(INBOX));

    it("is put back without the guard, which is the reported fault", () => {
        const server = new FakeServer();
        server.deliver(10);
        const pass = server.session();
        const action = server.session();
        let held = new Set(pass.fetchSequence(1, 10));

        // The delete, on its own connection: the server moves it, the row goes.
        expect(action.move(7)).toBe(true);
        held = new Set([...held].filter((uid) => uid !== 7));

        // The pass's refill lists the window by sequence on its stale session.
        const listed = pass.fetchSequence(1, 10);
        expect(listed).toContain(7);
        expect(missingFromWindow(listed, held, 400)).toEqual([7]);
    });

    it("is not fetched or stored again once the move is remembered", () => {
        const server = new FakeServer();
        server.deliver(10);
        const pass = server.session();
        const action = server.session();
        const held = new Set(pass.fetchSequence(1, 10));

        expect(action.move(7)).toBe(true);
        rememberRemoved(INBOX, [7n]);
        held.delete(7);

        const listed = pass.fetchSequence(1, 10);
        const known = new Set([...held, ...removedFrom(INBOX)]);
        expect(missingFromWindow(listed, known, 400)).toEqual([]);
        // And a fetch that already had it in hand is not stored either.
        const fetched = listed.map((uid) => ({ uid }));
        expect(withoutRemoved(INBOX, fetched).map((one) => one.uid)).not.toContain(7);

        // Once the session is told, the uid is simply not listed any more.
        pass.noop();
        expect(pass.fetchSequence(1, 10)).not.toContain(7);
    });

    it("only for the folder it left, and only for a while", () => {
        const now = 1_000_000;
        rememberRemoved(INBOX, [3], now);
        expect(withoutRemoved("trash-folder", [{ uid: 3 }], now)).toEqual([{ uid: 3 }]);
        expect(removedFrom(INBOX, now + REMOVED_KEEP_MS - 1).has(3)).toBe(true);
        expect(removedFrom(INBOX, now + REMOVED_KEEP_MS).has(3)).toBe(false);
    });

    it("is forgotten when the folder is renumbered", () => {
        rememberRemoved(INBOX, [3]);
        forgetRemoved(INBOX);
        expect(removedFrom(INBOX).size).toBe(0);
    });

    it("keeps a bounded list, newest kept", () => {
        const uids = Array.from({ length: REMOVED_PER_FOLDER + 5 }, (_, at) => at + 1);
        rememberRemoved(INBOX, uids);
        const kept = removedFrom(INBOX);
        expect(kept.size).toBe(REMOVED_PER_FOLDER);
        expect(kept.has(1)).toBe(false);
        expect(kept.has(REMOVED_PER_FOLDER + 5)).toBe(true);
    });
});

describe("every way Polaris takes mail out of a folder remembers it", () => {
    const source = (name: string) =>
        readFile(fileURLToPath(new URL(`../../src/lib/mailbox/${name}`, import.meta.url)), "utf8");

    it("moves, deletes, restores, sweeps and empties", async () => {
        const messages = await source("messages.ts");
        const trash = await source("trash.ts");
        // applyOne's delete and move, and the Move to menu.
        expect(messages.match(/rememberRemoved\(/g)?.length).toBe(3);
        // A restore, the sweep and Empty trash.
        expect(trash.match(/rememberRemoved\(/g)?.length).toBe(3);
    });

    it("and the sync refuses them in both places it stores from", async () => {
        const sync = await source("sync.ts");
        expect(sync).toContain("fetched = withoutRemoved(folder.id, fetched);");
        expect(sync).toContain("...removedFrom(folder.id)");
        expect(sync).toContain("forgetRemoved(folder.id);");
    });
});
