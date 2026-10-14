/**
 * Every count of unread mail outside the list, and how long it takes to agree
 * with the screen under it.
 *
 * The rail inside Mail, the app badge, the tab icon and the app menu each used
 * to keep an overlay of their own and drop it the moment their server figure
 * moved at all - so a recount a live frame set off just before the click put
 * the old number back. They now read one ledger (`lib/mailbox/unread-overlay`),
 * which keeps a change over any count asked for before it was confirmed and
 * takes it away at once when the server refuses.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
    beginUnreadChange,
    resetUnreadOverlay,
    subscribeUnreadOverlay,
    unreadOverlay,
    UNREAD_KEEP_MS
} from "@/lib/mailbox/unread-overlay";

const SCREENS = fileURLToPath(new URL("../../src/app/(app)/mail/", import.meta.url));
const COMPONENTS = fileURLToPath(new URL("../../src/components/", import.meta.url));

const INBOX = { folderId: "inbox-1", accountId: "account-1", inbox: true };
const ARCHIVE = { folderId: "archive-1", accountId: "account-1", inbox: false };

afterEach(() => resetUnreadOverlay());

describe("the shared ledger", () => {
    it("moves the folder, the mailbox and the app badge on one change", () => {
        beginUnreadChange([{ ...INBOX, by: -3 }]);
        expect(unreadOverlay(0)).toEqual({
            folders: { "inbox-1": -3 },
            accounts: { "account-1": -3 },
            inbox: -3
        });
    });

    it("moves only the folder for mail outside an inbox", () => {
        beginUnreadChange([{ ...ARCHIVE, by: -2 }]);
        expect(unreadOverlay(0)).toEqual({ folders: { "archive-1": -2 }, accounts: {}, inbox: 0 });
    });

    it("moves the app badge alone for a change that knows no folder", () => {
        beginUnreadChange([{ folderId: null, accountId: null, inbox: true, by: -5 }]);
        expect(unreadOverlay(0)).toEqual({ folders: {}, accounts: {}, inbox: -5 });
    });

    it("takes a refused change away at once", () => {
        const change = beginUnreadChange([{ ...INBOX, by: -1 }]);
        change.abandon();
        expect(unreadOverlay(0).inbox).toBe(0);
    });

    it("keeps a confirmed change over a count asked for before it", () => {
        const change = beginUnreadChange([{ ...INBOX, by: -1 }]);
        const askedBefore = Date.now() - 1;
        change.settle();
        expect(unreadOverlay(askedBefore).inbox).toBe(-1);
    });

    it("lets it go for a count asked for after it was confirmed", () => {
        const change = beginUnreadChange([{ ...INBOX, by: -1 }]);
        change.settle();
        expect(unreadOverlay(Date.now()).inbox).toBe(0);
    });

    it("forgets a confirmed change after a while regardless", () => {
        const change = beginUnreadChange([{ ...INBOX, by: -1 }]);
        change.settle();
        expect(unreadOverlay(0, Date.now() + UNREAD_KEEP_MS + 1).inbox).toBe(0);
    });

    it("is answered once: an abandon after a settle changes nothing", () => {
        const change = beginUnreadChange([{ ...INBOX, by: -1 }]);
        change.settle();
        change.abandon();
        expect(unreadOverlay(0).inbox).toBe(-1);
    });

    it("tells its readers when a change is confirmed, so they recount", () => {
        const events: string[] = [];
        const stop = subscribeUnreadOverlay((event) => events.push(event));
        const change = beginUnreadChange([{ ...INBOX, by: -1 }]);
        change.settle();
        stop();
        expect(events).toEqual(["begun", "settled"]);
    });

    it("records nothing for a change of nothing", () => {
        beginUnreadChange([{ ...INBOX, by: 0 }]);
        expect(unreadOverlay(0).inbox).toBe(0);
    });
});

describe("the counts that read it", () => {
    it("the app badge lays it over the server's count, never below nothing", async () => {
        const badge = await readFile(`${COMPONENTS}mail-unread.tsx`, "utf8");
        expect(badge).toContain("const by = unreadOverlay(countedAt).inbox;");
        expect(badge).toContain("Math.max(0, unread.messages + by)");
        expect(badge).toContain("mailboxes: messages === 0 ? 0 : unread.mailboxes");
        expect(badge).toContain('if (event === "settled") recount();');
    });

    it("the rail reads the same ledger and asks again once a change is confirmed", async () => {
        const shell = await readFile(`${SCREENS}mail-shell.tsx`, "utf8");
        expect(shell).toContain("() => unreadOverlay(rail.at)");
        expect(shell).toContain('if (event === "settled") pullRail();');
        expect(shell).toContain('inbox: folder.role === "inbox"');
    });

    it("the app menu marks mail on the ledger and answers it", async () => {
        const menu = await readFile(`${COMPONENTS}launcher-waiting.tsx`, "utf8");
        expect(menu).toContain("? beginUnreadChange([");
        expect(menu).toContain("mail?.abandon();");
        expect(menu).toContain("mail?.settle();");
    });

    it("every action in Mail answers its handle on both outcomes", async () => {
        const view = await readFile(`${SCREENS}mail-view.tsx`, "utf8");
        expect(view.match(/counts\??\.settle\(\)/g)?.length).toBeGreaterThanOrEqual(4);
        expect(view.match(/counts\??\.abandon\(\)/g)?.length).toBeGreaterThanOrEqual(7);
    });
});
