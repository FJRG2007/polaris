/**
 * A mailbox lent beyond reading (`mail.mailbox` respond / manage): every act
 * asks the grant at its level, reaches only the lent inbox, runs as the holder,
 * is logged naming the delegate, and a delegate's message is queued as theirs.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const BOX = "0192f0aa-0000-7000-8000-0000000000d1";
const IN = "0192f0aa-0000-7000-8000-0000000000d2";
const OUT = "0192f0aa-0000-7000-8000-0000000000d3";

const state = vi.hoisted(() => ({
    capability: "" as string,
    messageWhere: [] as unknown[],
    acted: [] as unknown[][],
    queued: [] as unknown[][],
    used: [] as Record<string, unknown>[],
    draftWhere: [] as unknown[],
    pairs: [] as { authorId: string; accountId: string }[],
    pruned: [] as unknown[]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        mailAccount: {
            findFirst: vi.fn(async (args: { where: { id: string } }) =>
                args.where.id === BOX ? { userId: "holder" } : null
            )
        },
        mailFolder: { findFirst: vi.fn(async () => ({ id: "inbox-1" })) },
        mailMessage: {
            findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => {
                state.messageWhere.push(args.where);
                return args.where.id.in.filter((id) => id === IN).map((id) => ({ id }));
            }),
            findFirst: vi.fn(async (args: { where: { id: string } }) => {
                state.messageWhere.push(args.where);
                return args.where.id === IN ? { id: IN } : null;
            })
        },
        mailDraft: {
            findMany: vi.fn(async (args: { distinct?: unknown }) =>
                args.distinct ? state.pairs : []
            ),
            findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
                state.draftWhere.push(args.where);
                return args.where.id === IN
                    ? {
                          id: IN,
                          toJson: [{ name: "", address: "ana@example.test" }],
                          ccJson: [],
                          subject: "Plans",
                          body: "Half written",
                          inReplyToId: null
                      }
                    : null;
            }),
            deleteMany: vi.fn(async (args: { where: unknown }) => {
                state.pruned.push(args.where);
                return { count: 2 };
            })
        }
    }
}));
vi.mock("@/lib/access/grants", () => ({
    liveGrants: vi.fn(async () =>
        state.capability ? [{ id: "grant-1", capability: state.capability }] : []
    ),
    grantedCapability: vi.fn(async (_user: string, _subject: string, accountId: string) =>
        accountId === BOX ? state.capability : ""
    ),
    grantedSubjects: vi.fn(async () => new Map()),
    recordGrantUse: vi.fn(async (use: Record<string, unknown>) => {
        state.used.push(use);
    }),
    recordGrantUses: vi.fn(async (uses: Record<string, unknown>[]) => {
        state.used.push(...uses);
    })
}));
vi.mock("@/lib/mailbox/messages", () => ({
    actOnMessages: vi.fn(async (...args: unknown[]) => {
        state.acted.push(args);
        return (args[1] as string[]).length;
    })
}));
vi.mock("@/lib/mailbox/compose", () => ({
    queueSend: vi.fn(async (...args: unknown[]) => {
        state.queued.push(args);
        return { draftId: "draft-1", sendAt: new Date(0) };
    }),
    cancelSend: vi.fn(async () => true),
    retrySend: vi.fn(async () => true),
    discardDraft: vi.fn(async () => undefined)
}));

const act = await import("@/lib/mailbox/delegate-act");
const { delegateMay } = await import("@/lib/mailbox/delegate");

beforeEach(() => {
    state.capability = "";
    state.messageWhere = [];
    state.acted = [];
    state.queued = [];
    state.used = [];
    state.draftWhere = [];
    state.pairs = [];
    state.pruned = [];
});

const compose = (extra: Record<string, unknown> = {}) =>
    core.mailDelegateComposeSchema.parse({
        accountId: BOX,
        to: [{ address: "ana@example.test" }],
        subject: "Re: Plans",
        body: "Yes",
        ...extra
    });

describe("the ladder", () => {
    it("is view < respond < manage, and no link", () => {
        expect(core.GRANT_CAPABILITIES["mail.mailbox"]).toEqual(["view", "respond", "manage"]);
        expect(delegateMay("manage", "respond")).toBe(true);
        expect(delegateMay("respond", "manage")).toBe(false);
        expect(delegateMay("view", "respond")).toBe(false);
    });

    it("never offers a permanent delete, a restore or a move", () => {
        expect(core.MAIL_DELEGATE_ACTIONS).not.toContain("delete");
        expect(core.MAIL_DELEGATE_ACTIONS).not.toContain("restore");
        expect(
            core.mailDelegateActionSchema.safeParse({
                accountId: BOX,
                messageIds: [IN],
                action: "delete"
            }).success
        ).toBe(false);
    });

    it("refuses a message with nobody to send it to", () => {
        const parsed = core.mailDelegateComposeSchema.safeParse({ accountId: BOX, to: [] });
        expect(parsed.success).toBe(false);
    });
});

describe("acting on the lent inbox", () => {
    const input = { accountId: BOX, messageIds: [IN, OUT], action: "archive" as const };

    it("is refused below manage, and without a grant", async () => {
        for (const level of ["", "view", "respond"]) {
            state.capability = level;
            await expect(act.delegateAct("delegate", input)).rejects.toThrow();
        }
        expect(state.acted).toEqual([]);
    });

    it("at manage, runs as the holder on the inbox messages only, and logs each", async () => {
        state.capability = "manage";
        expect(await act.delegateAct("delegate", input)).toBe(1);
        expect(state.messageWhere[0]).toMatchObject({ accountId: BOX, folderId: "inbox-1" });
        expect(state.acted).toEqual([["holder", [IN], "archive", { strict: true }]]);
        expect(state.used).toEqual([
            expect.objectContaining({
                grantId: "grant-1",
                subjectId: BOX,
                targetId: IN,
                userId: "delegate",
                action: "archive",
                outcome: "done"
            })
        ]);
    });

    it("is refused on a mailbox that is not lent", async () => {
        state.capability = "manage";
        await expect(act.delegateAct("delegate", { ...input, accountId: OUT })).rejects.toThrow();
    });
});

describe("writing from the lent mailbox", () => {
    it("is refused at view", async () => {
        state.capability = "view";
        await expect(act.delegateSend("delegate", compose())).rejects.toThrow();
        expect(state.queued).toEqual([]);
    });

    it("at respond, queues as the holder's mailbox with the delegate as author", async () => {
        state.capability = "respond";
        await act.delegateSend("delegate", compose({ inReplyToId: IN }));
        const [holder, queued, author] = state.queued[0] as [
            string,
            Record<string, unknown>,
            string
        ];
        expect(holder).toBe("holder");
        expect(author).toBe("delegate");
        expect(queued).toMatchObject({
            accountId: BOX,
            identityId: null,
            attachmentIds: [],
            inReplyToId: IN,
            requestReceipt: false
        });
    });

    it("never answers a message outside the lent inbox", async () => {
        state.capability = "manage";
        await expect(act.delegateSend("delegate", compose({ inReplyToId: OUT }))).rejects.toThrow();
        expect(state.queued).toEqual([]);
    });

    it("lets a delegate who lost respond still clear their own drafts", async () => {
        state.capability = "view";
        await expect(act.delegateDiscard("delegate", BOX, IN)).resolves.toBeUndefined();
        await expect(act.delegateRetry("delegate", BOX, IN)).rejects.toThrow();
    });
});

describe("going on writing an unsent message", () => {
    it("opens only the delegate's own draft, and never one on its way", async () => {
        state.capability = "respond";
        const draft = await act.delegateDraft("delegate", BOX, IN);
        expect(draft).toMatchObject({ id: IN, to: ["ana@example.test"], body: "Half written" });
        expect(state.draftWhere[0]).toMatchObject({
            accountId: BOX,
            authorId: "delegate",
            state: { in: ["draft", "failed"] }
        });
        await expect(act.delegateDraft("delegate", BOX, OUT)).rejects.toThrow();
    });

    it("is refused at view, since it is only opened to send", async () => {
        state.capability = "view";
        await expect(act.delegateDraft("delegate", BOX, IN)).rejects.toThrow();
        expect(state.draftWhere).toEqual([]);
    });
});

describe("drafts left on a mailbox no longer lent", () => {
    it("are thrown away, and those still lent are kept", async () => {
        state.capability = "view";
        state.pairs = [
            { authorId: "delegate", accountId: BOX },
            { authorId: "delegate", accountId: OUT }
        ];
        expect(await act.pruneOrphanDelegateDrafts(new Date("2026-09-19T10:00:00Z"))).toBe(2);
        expect(state.pruned).toEqual([
            expect.objectContaining({
                authorId: "delegate",
                accountId: OUT,
                state: { in: ["draft", "failed"] },
                updatedAt: { lt: new Date("2026-09-18T10:00:00Z") }
            })
        ]);
    });
});
