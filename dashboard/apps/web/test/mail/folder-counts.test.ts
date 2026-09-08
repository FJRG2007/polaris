/**
 * The number beside a folder, between syncs.
 *
 * `MailFolder.unread` is the mail server's own figure, and only a sync
 * overwrites it - so between syncs it is whatever this server does to it. The
 * failure pinned here is the one that was reported: a message read, a row that
 * stops being bold, and a rail beside it still saying three until the page is
 * reloaded.
 *
 * The arithmetic is what is tested. Writing it is a database call and reading it
 * back proves nothing about the sum that was written.
 */

import { addDelta, unseenByFolder } from "@/lib/mailbox/folder-counts";
import { describe, expect, it } from "vitest";

describe("what a set of messages owes each folder", () => {
    it("counts only the ones that were unread", () => {
        const deltas = unseenByFolder(
            [
                { folderId: "inbox", seen: false },
                { folderId: "inbox", seen: true },
                { folderId: "inbox", seen: false }
            ],
            -1
        );
        expect(deltas.get("inbox")).toBe(-2);
    });

    it("keeps each folder's own total apart", () => {
        const deltas = unseenByFolder(
            [
                { folderId: "inbox", seen: false },
                { folderId: "work", seen: false }
            ],
            -1
        );
        expect([...deltas.entries()].sort()).toEqual([
            ["inbox", -1],
            ["work", -1]
        ]);
    });

    it("has nothing to say about mail that was already read", () => {
        expect(unseenByFolder([{ folderId: "inbox", seen: true }], -1).size).toBe(0);
    });

    it("counts the other way for a folder that is gaining them", () => {
        expect(unseenByFolder([{ folderId: "archive", seen: false }], 1).get("archive")).toBe(1);
    });
});

describe("adding one folder's change into a running total", () => {
    it("accumulates", () => {
        const deltas = new Map<string, number>();
        addDelta(deltas, "inbox", -1);
        addDelta(deltas, "inbox", -2);
        expect(deltas.get("inbox")).toBe(-3);
    });

    it("drops a change that cancels itself out", () => {
        // A message moved out of a folder and back into it is not a folder that
        // has to be written at all.
        const deltas = new Map<string, number>();
        addDelta(deltas, "inbox", -1);
        addDelta(deltas, "inbox", 1);
        expect(deltas.has("inbox")).toBe(false);
    });

    it("ignores a change of nothing", () => {
        const deltas = new Map<string, number>();
        addDelta(deltas, "inbox", 0);
        expect(deltas.size).toBe(0);
    });
});
