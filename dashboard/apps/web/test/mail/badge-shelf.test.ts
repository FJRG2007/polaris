/**
 * The Mail badge counts the mailboxes Mail lists.
 *
 * It used to count every mailbox the account had, while Mail itself lists the
 * open shelf's - so a company mailbox's unread mail was a number on the
 * personal shelf, and opening Mail there showed an empty inbox.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let openOrg: string | null = null;
const asked: Array<{ account: { userId: string; orgId?: string | null } }> = [];
/** Unread inbox messages per mailbox, and the shelf each mailbox is on. */
const mailboxes = [
    { id: "own", orgId: null, unread: 2 },
    { id: "acme-sales", orgId: "acme", unread: 5 },
    { id: "acme-billing", orgId: "acme", unread: 0 }
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
            groupBy: async ({ where }: { where: { account: { userId: string; orgId?: string | null } } }) => {
                asked.push(where);
                return mailboxes
                    .filter((box) => box.unread > 0)
                    .filter((box) => !("orgId" in where.account) || box.orgId === where.account.orgId)
                    .map((box) => ({ accountId: box.id, _count: { _all: box.unread } }));
            }
        }
    }
}));

const { mailWaitingOnShelf } = await import("@/lib/shelf-counts");

beforeEach(() => {
    openOrg = null;
    asked.length = 0;
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
