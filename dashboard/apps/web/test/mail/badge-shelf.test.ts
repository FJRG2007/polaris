/**
 * The Mail badge counts the mailboxes Mail lists.
 *
 * It used to count every mailbox the account had, while Mail itself lists the
 * open shelf's - so a company mailbox's unread mail was a number on the
 * personal shelf, and opening Mail there showed an empty inbox.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface MailWhere {
    account: { userId: string; orgId?: string | null };
    createdAt?: { gt: Date };
}

let openOrg: string | null = null;
/** When the reader cleared Mail's badge from the app list, as stored. */
let badgeCleared: string | null = null;
const asked: MailWhere[] = [];
/** Unread inbox messages per mailbox, the shelf each mailbox is on, and when
 *  its unread mail arrived. */
const mailboxes = [
    { id: "own", orgId: null, unread: 2, arrivedAt: new Date("2026-08-18T09:00:00Z") },
    { id: "acme-sales", orgId: "acme", unread: 5, arrivedAt: new Date("2026-08-18T09:00:00Z") },
    { id: "acme-billing", orgId: "acme", unread: 0, arrivedAt: new Date("2026-08-18T09:00:00Z") }
];

vi.mock("@/lib/workspace-scope", () => ({ scopeOrgIdFor: async () => openOrg }));
// Mail resolves its own shelf, which is the header's unless somebody asked for
// every mailbox - a preference this test is not about.
vi.mock("@/lib/mailbox/shelf", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/mailbox/shelf")>()),
    mailShelfFor: async () => openOrg
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        mailMessage: {
            groupBy: async ({ where }: { where: MailWhere }) => {
                asked.push(where);
                return mailboxes
                    .filter((box) => box.unread > 0)
                    .filter((box) => !("orgId" in where.account) || box.orgId === where.account.orgId)
                    .filter((box) => !where.createdAt || box.arrivedAt > where.createdAt.gt)
                    .map((box) => ({ accountId: box.id, _count: { _all: box.unread } }));
            }
        },
        userBadgeSeen: {
            findUnique: async () => (badgeCleared ? { mark: badgeCleared } : null)
        }
    }
}));

const { mailWaitingOnShelf } = await import("@/lib/shelf-counts");

beforeEach(() => {
    openOrg = null;
    badgeCleared = null;
    asked.length = 0;
    mailboxes[0]!.arrivedAt = new Date("2026-08-18T09:00:00Z");
});

describe("the Mail badge", () => {
    it("counts only somebody's own mailboxes on the personal shelf", async () => {
        expect(await mailWaitingOnShelf("u1")).toEqual({ messages: 2, mailboxes: 1 });
        expect(asked[0]?.account).toEqual({ userId: "u1", orgId: null });
    });

    it("counts only the organization's mailboxes on its shelf", async () => {
        openOrg = "acme";
        expect(await mailWaitingOnShelf("u1")).toEqual({ messages: 5, mailboxes: 1 });
        expect(asked[0]?.account).toEqual({ userId: "u1", orgId: "acme" });
    });

    it("is nothing on a shelf with no mailboxes, whatever waits elsewhere", async () => {
        openOrg = "globex";
        expect(await mailWaitingOnShelf("u1")).toEqual({ messages: 0, mailboxes: 0 });
    });
});

describe("the Mail badge cleared from the app list", () => {
    it("stops counting what came before, and counts what arrives after", async () => {
        badgeCleared = "2026-08-18T10:00:00.000Z";
        expect(await mailWaitingOnShelf("u1")).toEqual({ messages: 0, mailboxes: 0 });
        expect(asked[0]?.createdAt).toEqual({ gt: new Date(badgeCleared) });
        mailboxes[0]!.arrivedAt = new Date("2026-08-18T11:00:00Z");
        expect(await mailWaitingOnShelf("u1")).toEqual({ messages: 2, mailboxes: 1 });
    });

    it("leaves the mail unread in Mail, whose rail never passes the mark", async () => {
        badgeCleared = "2026-08-18T10:00:00.000Z";
        const { unreadCounts } = await import("@/lib/mailbox/views");
        expect((await unreadCounts("u1", null)).total).toBe(2);
        expect(asked.at(-1)?.createdAt).toBeUndefined();
    });
});
