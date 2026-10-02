/**
 * A row changes when it is pressed, and changes back when the server says no.
 *
 * Every action on a conversation is a round trip to somebody else's mail
 * server, so the list does not wait for it: the row is drawn as the action will
 * leave it, and a refusal takes the overlay away again - which is the rollback,
 * because the overlay is the only place the change ever lived. These pin the
 * three halves of that: what each action looks like before it is confirmed,
 * that overlays stack without losing each other, and that a row taken out of the
 * list stays out exactly as long as the list still sends it.
 */

import { describe, expect, it } from "vitest";
import {
    optimistically,
    stillOwed,
    withPatch,
    type ThreadPatch
} from "@/app/(app)/mail/optimistic";

/** A row as the list draws it: the server's, with the overlay laid over. */
function drawn<T extends object>(row: T & { id: string }, held: Record<string, ThreadPatch>): T {
    return { ...row, ...held[row.id] };
}

const ROW = { id: "t1", unreadCount: 2, starred: false, important: false };

describe("how a row looks before the server answers", () => {
    it("reads, stars and marks at once", () => {
        expect(optimistically("read")).toEqual({ unreadCount: 0 });
        expect(optimistically("unread")).toEqual({ unreadCount: 1 });
        expect(optimistically("star")).toEqual({ starred: true });
        expect(optimistically("unstar")).toEqual({ starred: false });
        expect(optimistically("important")).toEqual({ important: true });
        expect(optimistically("unimportant")).toEqual({ important: false });
    });

    it("takes the row out for everything that files it", () => {
        for (const action of ["archive", "trash", "delete", "junk"] as const) {
            expect(optimistically(action), action).toEqual({ gone: true });
        }
    });
});

describe("the overlay and its rollback", () => {
    it("draws the change before anything is confirmed", () => {
        const held = withPatch({}, ["t1"], optimistically("star")!);
        expect(drawn(ROW, held)).toMatchObject({ starred: true, unreadCount: 2 });
    });

    it("stacks a second press on the first without losing it", () => {
        const starred = withPatch({}, ["t1"], optimistically("star")!);
        const both = withPatch(starred, ["t1"], optimistically("read")!);
        expect(drawn(ROW, both)).toMatchObject({ starred: true, unreadCount: 0 });
        // And never edits the record it was handed: React compares by identity.
        expect(starred.t1).toEqual({ starred: true });
    });

    it("is undone by dropping the overlay, which leaves the server's row", () => {
        const held = withPatch({}, ["t1"], optimistically("archive")!);
        expect(drawn(ROW, held)).toMatchObject({ gone: true });
        // A refusal clears what is held - and the row is the server's again.
        expect(drawn(ROW, {})).toEqual(ROW);
    });

    it("only touches the rows it was aimed at", () => {
        const held = withPatch({}, ["t1"], optimistically("trash")!);
        expect(drawn({ id: "t2", starred: false }, held)).toEqual({ id: "t2", starred: false });
    });
});

describe("a list arriving while an action is still out", () => {
    it("keeps a row hidden while the list still sends it", () => {
        // The list painted from what the tab held predates the delete.
        const owed = stillOwed({ t1: { gone: true } }, new Set(["t1", "t2"]));
        expect(owed).toEqual({ t1: { gone: true } });
    });

    it("lets it go once the list has stopped sending it", () => {
        expect(stillOwed({ t1: { gone: true } }, new Set(["t2"]))).toEqual({});
    });

    it("keeps a change to a row that is still there", () => {
        const owed = stillOwed({ t1: { starred: true }, t3: { gone: true } }, new Set(["t1"]));
        expect(owed).toEqual({ t1: { starred: true } });
    });
});
