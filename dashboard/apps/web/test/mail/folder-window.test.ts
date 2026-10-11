/**
 * A folder's cached window stays whole.
 *
 * An inbox of three thousand messages showed two: rows dropped by mistake are
 * behind the sync cursor and were never fetched again. A pass now needs two
 * commands to agree before it drops a row, and puts back whatever the newest
 * window is missing - as old mail, never as arrivals.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { confirmedGone, missingFromWindow, reachesForOlder } from "@/lib/mailbox/folder-window";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const sync = readFile(`${SRC}lib/mailbox/sync.ts`, "utf8");

describe("dropping a row", () => {
    const rows = [{ uid: 10n }, { uid: 11n }, { uid: 12n }];

    it("drops only what the second command did not find either", () => {
        expect(confirmedGone(rows, new Set([10, 12]))).toEqual([{ uid: 11n }]);
    });

    it("drops nothing when the fetch still finds every one", () => {
        expect(confirmedGone(rows, new Set([10, 11, 12]))).toEqual([]);
    });

    it("asks the server a second time before deleting", async () => {
        const source = await sync;
        const reconcile = source.slice(source.indexOf("async function reconcileDeletions"));
        const body = reconcile.slice(0, reconcile.indexOf("\n}\n"));
        expect(body.indexOf("client.fetch(")).toBeGreaterThan(-1);
        expect(body.indexOf("client.fetch(")).toBeLessThan(body.indexOf("deleteMany"));
    });
});

describe("the newest window", () => {
    it("lists what is not held, newest first", () => {
        expect(missingFromWindow([5, 9, 7, 8], new Set([9, 5]), 400)).toEqual([8, 7]);
    });

    it("looks no further back than the window", () => {
        expect(missingFromWindow([1, 2, 3, 4], new Set([4]), 2)).toEqual([3]);
    });

    it("finds nothing missing in a whole window", () => {
        expect(missingFromWindow([1, 2], new Set([1, 2]), 400)).toEqual([]);
    });

    it("is refilled on every pass, and as old mail rather than arrivals", async () => {
        const source = await sync;
        expect(source).toContain(
            "await refillWindow(client, account, folder, mailbox.exists, extraHeaders);"
        );
        expect(source).toContain("await storeMessages(client, account, folder, fetched, false);");
        expect(source).toContain("if (isNew && arrivals) {");
    });

    it("lists the window instead of trusting a count of the whole folder", async () => {
        const source = await sync;
        const refill = source.slice(source.indexOf("async function refillWindow"));
        const body = refill.slice(0, refill.indexOf("\n}\n"));
        expect(body).not.toContain("mailMessage.count(");
    });

    it("does not fetch Polaris' own draft copies again on every pass", async () => {
        const source = await sync;
        const refill = source.slice(source.indexOf("async function refillWindow"));
        const body = refill.slice(0, refill.indexOf("\n}\n"));
        expect(body).toContain("unstored.get(folder.id)");
        expect(source).toContain("if (stored === 0) return 0;");
    });
});

describe("scrolling past the held window", () => {
    const inbox = {
        folderId: null,
        role: "inbox",
        query: "",
        sort: "newest",
        labelId: null,
        unreadOnly: false,
        readOnly: false,
        starredOnly: false,
        importantOnly: false,
        snoozedOnly: false,
        withAttachments: false,
        category: ""
    };

    it("reaches for older mail at the end of a plain folder list", () => {
        expect(reachesForOlder(inbox)).toBe(true);
        expect(reachesForOlder({ ...inbox, role: null, folderId: "f1" })).toBe(true);
    });

    it("never for a search, a filter, another order or no folder at all", () => {
        expect(reachesForOlder({ ...inbox, query: "invoice" })).toBe(false);
        expect(reachesForOlder({ ...inbox, sort: "oldest" })).toBe(false);
        expect(reachesForOlder({ ...inbox, unreadOnly: true })).toBe(false);
        expect(reachesForOlder({ ...inbox, starredOnly: true })).toBe(false);
        expect(reachesForOlder({ ...inbox, labelId: "l1" })).toBe(false);
        expect(reachesForOlder({ ...inbox, category: "social" })).toBe(false);
        expect(reachesForOlder({ ...inbox, role: null })).toBe(false);
    });

    it("brings the next page down as old mail, below what is held, and lists again", async () => {
        const source = await sync;
        const older = source.slice(source.indexOf("async function fetchOlderNow"));
        const body = older.slice(0, older.indexOf("\n}\n"));
        expect(body).toContain(
            "(await storeMessages(client, account, folder, fetched, false)) > 0"
        );
        expect(body).toContain("readOnly: true");
        const route = await readFile(`${SRC}app/api/mail/threads/route.ts`, "utf8");
        expect(route).toContain('page.cursor === "" && reachesForOlder(list)');
        expect(route).toContain("everyAccountId(user.id)");
    });

    it("skips Polaris' own draft copies instead of fetching them on every reach", async () => {
        const source = await sync;
        const older = source.slice(source.indexOf("async function fetchOlderNow"));
        const body = older.slice(0, older.indexOf("\n}\n"));
        expect(body).toContain("unstored.get(folderId)");
        expect(body).toContain("held.length + skipped.size >= folder.total");
        expect(body).toContain("...skipped]");
    });

    it("never runs beside the mailbox's pass or a second reach for the same folder", async () => {
        const source = await sync;
        const entry = source.slice(source.indexOf("export async function fetchOlder("));
        const body = entry.slice(0, entry.indexOf("\n}\n"));
        expect(body).toContain("olderRuns().get(folderId)");
        expect(body).toContain("passes().get(accountId)");
        const pass = source.slice(source.indexOf("export async function syncAccount"));
        expect(pass.slice(0, pass.indexOf("\n}\n"))).toContain("settleOlder(accountId)");
    });
});
