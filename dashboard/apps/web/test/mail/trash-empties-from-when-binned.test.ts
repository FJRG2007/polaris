/**
 * The trash auto-empty counts from when a message went into the trash.
 *
 * It used to ask the server for `SEARCH BEFORE`, which compares the date a
 * message arrived (INTERNALDATE) - a date a move keeps. An old message binned
 * today was therefore "a month in the bin" and destroyed on the next sweep.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { sweepableUids } from "@/lib/mailbox/trash-sweep";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-11-16T12:00:00Z").getTime();
const before = new Date(now - 30 * DAY);

describe("what the auto-empty may destroy", () => {
    it("keeps a message received 90 days ago and binned today", () => {
        // The server's search names it: it arrived long ago.
        const serverOld = [41];
        expect(sweepableUids(serverOld, [{ uid: 41n, trashedAt: new Date(now) }], before)).toEqual(
            []
        );
    });

    it("destroys one that has been in the trash 31 days", () => {
        const held = [{ uid: 42n, trashedAt: new Date(now - 31 * DAY) }];
        expect(sweepableUids([42], held, before)).toEqual([42]);
    });

    it("waits on anything it cannot date", () => {
        // Not held here, held without a date, and held but not old on the server.
        const held = [
            { uid: 43n, trashedAt: null },
            { uid: 44n, trashedAt: new Date(now - 40 * DAY) }
        ];
        expect(sweepableUids([43, 45], held, before)).toEqual([]);
    });
});

describe("where the date comes from", () => {
    const read = (path: string) =>
        readFile(fileURLToPath(new URL(path, import.meta.url)), "utf8");

    it("is written when a row is stored into the trash", async () => {
        const sync = await read("../../src/lib/mailbox/sync.ts");
        expect(sync).toContain('folder.role === "trash" ? await trashMoments(account.id, fetched)');
        expect(sync).toContain("trashedAt: trashedAt.get(shape.messageId) ?? new Date()");
    });

    it("and is backfilled for what is already in a trash, rerunnably", async () => {
        const sql = await read(
            "../../../../packages/db/prisma/migrations/20271120000240_mail_trashed_at/migration.sql"
        );
        expect(sql).toContain('ADD COLUMN IF NOT EXISTS "trashedAt"');
        expect(sql).toContain('AND m."trashedAt" IS NULL');
    });

    it("and the sweep asks both the server and the row", async () => {
        const trash = await read("../../src/lib/mailbox/trash.ts");
        expect(trash).toContain("sweepableUids(old, held, before)");
        expect(trash).toContain("if (!removed) return;");
    });
});
