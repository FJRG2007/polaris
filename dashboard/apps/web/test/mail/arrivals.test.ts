/**
 * Which new mail is worth a notice from the system.
 *
 * The rules are all in one query, so the query is what is pinned: only the
 * reader's own mailboxes with "Notify me" on, only unread mail in an inbox,
 * never a muted conversation or a snoozed message, only mail first seen after
 * the cursor - and a tab's first ask announces nothing at all, so opening
 * Polaris never raises a notice about mail that was already there.
 *
 * And only the mailboxes Mail is drawing: the shelf in view, or every one of
 * them where somebody asked Mail to show them all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let lastWhere: Record<string, unknown> | null = null;
let queried = 0;
let rows: { threadId: string; subject: string; fromJson: unknown }[] = [];
let total = 0;

vi.mock("@polaris/db", () => ({
    prisma: {
        mailMessage: {
            findMany: async (query: { where: Record<string, unknown> }) => {
                queried += 1;
                lastWhere = query.where;
                return rows;
            },
            count: async () => total
        }
    }
}));

let shelf: string | null = null;
vi.mock("@/lib/mailbox/shelf", async () => {
    const real = await vi.importActual<typeof import("@/lib/mailbox/shelf")>(
        "@/lib/mailbox/shelf"
    );
    return { ...real, mailShelfFor: async () => shelf };
});

const { EVERY_SHELF } = await import("@/lib/mailbox/shelf");
const { arrivalsSince } = await import("@/lib/mailbox/arrivals");

beforeEach(() => {
    lastWhere = null;
    queried = 0;
    rows = [];
    total = 0;
    shelf = null;
});

describe("a tab's first ask", () => {
    it("announces nothing and hands out a cursor", async () => {
        const answer = await arrivalsSince("u1", null);
        expect(answer.named).toEqual([]);
        expect(answer.more).toBe(0);
        expect(Number.isNaN(Date.parse(answer.cursor))).toBe(false);
        expect(queried).toBe(0);
    });
});

describe("what is worth announcing", () => {
    it("asks only for unread inbox mail on mailboxes that want it, outside muted conversations", async () => {
        const since = new Date("2026-09-10T10:00:00Z");
        await arrivalsSince("u1", since);
        expect(lastWhere).toMatchObject({
            account: { userId: "u1", orgId: null, notify: true },
            createdAt: { gt: since },
            seen: false,
            deleted: false,
            folder: { role: "inbox" },
            thread: { muted: false }
        });
    });

    it("names the newest few by sender and counts the rest", async () => {
        rows = [
            {
                threadId: "t1",
                subject: "Invoice for March",
                fromJson: [{ name: "Ana", address: "ana@example.com" }]
            },
            { threadId: "t2", subject: "  ", fromJson: [{ name: "", address: "bo@example.com" }] }
        ];
        total = 7;
        const answer = await arrivalsSince("u1", new Date("2026-09-10T10:00:00Z"));
        expect(answer.named).toEqual([
            { threadId: "t1", from: "Ana", subject: "Invoice for March" },
            { threadId: "t2", from: "bo", subject: "(no subject)" }
        ]);
        expect(answer.more).toBe(5);
    });
});

describe("which mailboxes are announced", () => {
    const since = new Date("2026-09-10T10:00:00Z");

    it("is the shelf in view, so a notice never points at mail Mail is not listing", async () => {
        shelf = "org-acme";
        await arrivalsSince("u1", since);
        expect(lastWhere?.account).toEqual({ userId: "u1", orgId: "org-acme", notify: true });
    });

    it("is every mailbox once somebody asked Mail to show them all", async () => {
        shelf = EVERY_SHELF;
        await arrivalsSince("u1", since);
        expect(lastWhere?.account).toEqual({ userId: "u1", notify: true });
    });
});
