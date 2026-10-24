/**
 * A mailbox lent to somebody to read (`mail.mailbox`): only through a live
 * grant, never their own mailbox a second way, never what is not in it, lent
 * only by the person who linked it, and gone with the mailbox.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const BOX = "0192f0aa-0000-7000-8000-0000000000c1";
const MSG = "0192f0aa-0000-7000-8000-0000000000c2";

const state = vi.hoisted(() => ({
    lent: new Map<string, string>(),
    accountWhere: [] as unknown[],
    messageWhere: [] as unknown[],
    dropped: [] as string[]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        mailAccount: {
            findFirst: vi.fn(async (args: { where: { id: string; userId: unknown } }) => {
                state.accountWhere.push(args.where);
                if (args.where.id !== BOX) return null;
                // The holder is "holder": a filter that excludes them finds nothing.
                const userId = args.where.userId;
                if (typeof userId === "string") {
                    return userId === "holder" ? { id: BOX, userId: "holder" } : null;
                }
                if ((userId as { not: string }).not === "holder") return null;
                return { id: BOX, address: "boss@example.test", label: "", displayName: "Boss" };
            }),
            findMany: vi.fn(async () => [
                { id: BOX, address: "boss@example.test", label: "", displayName: "Boss" }
            ])
        },
        mailFolder: { findFirst: vi.fn(async () => ({ id: "inbox-1" })) },
        mailMessage: {
            findMany: vi.fn(async (args: { where: unknown; take: number }) => {
                state.messageWhere.push(args.where);
                return Array.from({ length: args.take }, (_, index) => ({
                    id: `m${index}`,
                    subject: `Subject ${index}`,
                    fromJson: [{ name: "Ana", address: "ana@example.test" }],
                    snippet: "Hello",
                    sentAt: new Date(Date.UTC(2026, 9, 20) - index * 60_000),
                    hasAttachments: false
                }));
            }),
            findFirst: vi.fn(async (args: { where: { id: string } }) => {
                state.messageWhere.push(args.where);
                return args.where.id === MSG
                    ? {
                          id: MSG,
                          subject: "Plans",
                          fromJson: [{ name: "Ana", address: "ana@example.test" }],
                          toJson: [{ name: "", address: "boss@example.test" }],
                          ccJson: [],
                          snippet: "Hello",
                          sentAt: new Date(Date.UTC(2026, 9, 20)),
                          hasAttachments: true,
                          bodyText: "<b>not html</b>"
                      }
                    : null;
            })
        }
    }
}));
vi.mock("@/lib/access/grants", () => ({
    grantedSubjects: vi.fn(async () => state.lent),
    grantedCapability: vi.fn(
        async (_user: string, _subject: string, id: string) => state.lent.get(id) ?? ""
    ),
    dropGrantsFor: vi.fn(async (_subject: string, id: string) => {
        state.dropped.push(id);
    }),
    GrantError: class GrantError extends Error {}
}));
vi.mock("@/lib/session", () => ({ sessionCan: vi.fn(async () => false) }));
vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: vi.fn(async () => []) }));
vi.mock("@/lib/notes/access", () => ({ requireSpace: vi.fn(), requireNote: vi.fn() }));
vi.mock("@/lib/office/documents", () => ({ requireShareable: vi.fn() }));
vi.mock("@/lib/chat/access", () => ({ requireSpace: vi.fn(), requireChannel: vi.fn() }));
vi.mock("@/lib/tasks/access", () => ({ requireSpace: vi.fn(), requireFolder: vi.fn() }));
vi.mock("@/lib/machines/machine-access", () => ({ domainOwner: vi.fn(), lendableServer: vi.fn() }));

const delegate = await import("@/lib/mailbox/delegate");
const { requireMayShare, subjectHref } = await import("@/lib/access/sharing-service");
const core = await import("@polaris/core");

type Sharer = Parameters<typeof requireMayShare>[0];
const as = (id: string) => ({ id, isAdmin: true }) as unknown as Sharer;

beforeEach(() => {
    state.lent = new Map();
    state.accountWhere = [];
    state.messageWhere = [];
    state.dropped = [];
});

describe("a mailbox lent to read", () => {
    it("is a read-only subject, never a link", () => {
        expect(core.GRANT_CAPABILITIES["mail.mailbox"]).toEqual(["view"]);
        expect(core.GRANT_ACTIONS["mail.mailbox"]).toEqual([]);
        expect(core.isGrantLinkSubject("mail.mailbox")).toBe(false);
    });

    it("is refused without a grant, whatever the id", async () => {
        await expect(delegate.delegatedMailbox("reader", BOX)).rejects.toThrow();
        expect(state.accountWhere).toEqual([]);
    });

    it("opens through a grant, and never as a second way into the reader's own", async () => {
        state.lent.set(BOX, "view");
        await expect(delegate.delegatedMailbox("reader", BOX)).resolves.toMatchObject({
            address: "boss@example.test"
        });
        expect(state.accountWhere.at(-1)).toEqual({ id: BOX, userId: { not: "reader" } });
        await expect(delegate.delegatedMailbox("holder", BOX)).rejects.toThrow();
    });

    it("lists one bounded page of the inbox, without drafts or deleted mail", async () => {
        state.lent.set(BOX, "view");
        const { rows, more } = await delegate.delegatedInbox("reader", BOX);
        expect(rows).toHaveLength(delegate.DELEGATE_PAGE);
        expect(more).toBe(true);
        expect(rows[0]).toMatchObject({ from: "Ana", subject: "Subject 0" });
        expect(state.messageWhere.at(-1)).toEqual({
            accountId: BOX,
            folderId: "inbox-1",
            deleted: false,
            draft: false
        });
    });

    it("resumes after the last row shown, keeping messages sent the same second", async () => {
        state.lent.set(BOX, "view");
        const sentAt = new Date(Date.UTC(2026, 9, 20));
        await delegate.delegatedInbox("reader", BOX, { sentAt, id: MSG });
        expect(state.messageWhere.at(-1)).toEqual({
            accountId: BOX,
            folderId: "inbox-1",
            deleted: false,
            draft: false,
            OR: [{ sentAt: { lt: sentAt } }, { sentAt, id: { lt: MSG } }]
        });
    });

    it("reads one message of that mailbox as text, and nothing from another", async () => {
        state.lent.set(BOX, "view");
        const message = await delegate.delegatedMessage("reader", BOX, MSG);
        expect(message).toMatchObject({
            from: "Ana <ana@example.test>",
            to: ["boss@example.test"],
            bodyText: "<b>not html</b>"
        });
        expect(state.messageWhere.at(-1)).toEqual({
            id: MSG,
            accountId: BOX,
            folderId: "inbox-1",
            deleted: false,
            draft: false
        });
        await expect(delegate.delegatedMessage("reader", BOX, "other")).rejects.toThrow();
    });

    it("lists the mailboxes lent to the reader, never their own", async () => {
        expect(await delegate.delegatedMailboxes("reader")).toEqual([]);
        state.lent.set(BOX, "view");
        expect(await delegate.delegatedMailboxes("reader")).toHaveLength(1);
    });

    it("is lent only by the person who linked it", async () => {
        await expect(requireMayShare(as("someone"), "mail.mailbox", BOX)).rejects.toThrow();
        await expect(requireMayShare(as("holder"), "mail.mailbox", BOX)).resolves.toBeUndefined();
        expect(subjectHref("mail.mailbox", BOX)).toBe(`/mail/shared/${BOX}`);
    });
});
