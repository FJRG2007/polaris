import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = new Map<string, string>();
const channel = {
    id: "c1",
    kind: "dm",
    spaceId: null as string | null,
    vanishAfter: 0,
    deleteForAll: false,
    rulesAgreedAt: null as Date | null
};
let members = ["me", "other"];
let proposal: Record<string, unknown> | null = null;
let due: { id: string; channelId: string; parentId: string | null }[][] = [];
let access: { member: boolean } | null = { member: true };
const notices: string[] = [];
const discarded: string[] = [];

const tx = {
    chatMessage: { deleteMany: vi.fn(), updateMany: vi.fn() },
    // Answers the way the database would against the one proposal row: a
    // guarded update that appends a vote in place, and a read of what is there.
    chatRuleProposal: {
        updateMany: vi.fn(async (args: { where: ProposalWhere; data: ProposalData }) => {
            if (!proposal) return { count: 0 };
            const row = proposal as { status: string; acceptedBy: string[] };
            if (args.where.status && row.status !== args.where.status) return { count: 0 };
            if (args.where.NOT && row.acceptedBy.includes(args.where.NOT.acceptedBy.has)) {
                return { count: 0 };
            }
            if (args.data.acceptedBy) row.acceptedBy = [...row.acceptedBy, args.data.acceptedBy.push];
            if (args.data.status) row.status = args.data.status;
            return { count: 1 };
        }),
        findUnique: vi.fn(async () => proposal)
    },
    chatChannel: { update: vi.fn() }
};
type ProposalWhere = { status?: string; NOT?: { acceptedBy: { has: string } } };
type ProposalData = { acceptedBy?: { push: string }; status?: string };
const prisma = {
    chatChannel: {
        findUnique: vi.fn(async () => ({ ...channel, ruleProposals: [] })),
        update: vi.fn()
    },
    chatChannelMember: {
        findMany: vi.fn(async () => members.map((userId) => ({ userId }))),
        updateMany: vi.fn(async () => ({ count: 1 }))
    },
    chatRuleProposal: {
        findUnique: vi.fn(async () => proposal),
        updateMany: vi.fn(async () => ({ count: 1 })),
        create: vi.fn(async () => ({}))
    },
    chatMessage: {
        findMany: vi.fn(async (args: { where: { parentId?: unknown } }) =>
            args.where.parentId ? [{ id: "reply" }] : (due.shift() ?? [])
        ),
        findUnique: vi.fn(async () => ({ channelId: "c1", parentId: null })),
        updateMany: vi.fn(async () => ({ count: 3 }))
    },
    chatAttachment: {
        findMany: vi.fn(async () => [{ messageId: "m1" }, { messageId: "reply" }])
    },
    chatMessageHidden: { createMany: vi.fn(async () => ({ count: 1 })) },
    user: { findUnique: vi.fn(async () => ({ name: "Ada" })) },
    userPrivacy: { findUnique: vi.fn(async (): Promise<unknown> => null) },
    $transaction: vi.fn(async (work: unknown) =>
        typeof work === "function"
            ? (work as (t: typeof tx) => unknown)(tx)
            : Promise.all(work as unknown[])
    )
};

vi.mock("@polaris/db", () => ({ prisma }));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string | null) => {
        if (value === null) settings.delete(key);
        else settings.set(key, value);
    }
}));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async () => ({ ok: true, retryAfterMs: 0 })
}));
vi.mock("@/lib/chat/access", () => {
    class ChatAccessError extends Error {
        readonly text: { key: string };
        constructor(text: { key: string } = { key: "errors.notInConversation" }) {
            super(text.key);
            this.text = text;
        }
    }
    class ChatRuleError extends ChatAccessError {}
    return {
        ChatAccessError,
        ChatRuleError,
        requireChannel: async () => {
            if (!access) throw new ChatAccessError();
            return { ...access, channelId: "c1", spaceId: null, kind: "dm" };
        }
    };
});
vi.mock("@/lib/chat/live", () => ({ publishChatChange: vi.fn() }));
vi.mock("@/lib/chat/notices", () => ({
    postNoticeBody: async (_channel: string, body: string) => {
        notices.push(body);
    }
}));
vi.mock("@/lib/chat/attachments", () => ({
    discardAttachments: async (id: string) => {
        discarded.push(id);
    }
}));

const vanish = await import("@/lib/chat/vanish");
const me = { id: "me" };
const other = { id: "other" };

function pending(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: "p1",
        channelId: "c1",
        status: "pending",
        acceptedBy: ["me"],
        vanishAfter: 86_400,
        deleteForAll: true,
        ...extra
    };
}

beforeEach(() => {
    settings.clear();
    Object.assign(channel, {
        kind: "dm",
        spaceId: null,
        vanishAfter: 0,
        deleteForAll: false,
        rulesAgreedAt: null
    });
    members = ["me", "other"];
    proposal = null;
    access = { member: true };
    notices.length = 0;
    discarded.length = 0;
    due = [];
    vi.clearAllMocks();
});

describe("permissions", () => {
    it("refuses somebody who is not in the conversation", async () => {
        access = null;
        await expect(vanish.setVanishTimer(me, "c1", 86_400)).rejects.toThrow(
            "errors.notInConversation"
        );
        access = { member: false };
        await expect(vanish.deleteChatForAll(me, "c1")).rejects.toThrow(
            "errors.notInConversation"
        );
        await expect(vanish.clearChatForMe(me, "c1")).rejects.toThrow("errors.notInConversation");
    });

    it("refuses a space's channel", async () => {
        Object.assign(channel, { kind: "text", spaceId: "s1" });
        await expect(vanish.setVanishTimer(me, "c1", 86_400)).rejects.toThrow(
            "errors.vanishNotHere"
        );
    });

    it("refuses a timer that is not offered", async () => {
        await expect(vanish.setVanishTimer(me, "c1", 3600)).rejects.toThrow(
            "errors.vanishBadDuration"
        );
    });

    it("open: either person sets the timer directly and a line says so", async () => {
        await vanish.setVanishTimer(other, "c1", 604_800);
        expect(prisma.chatChannel.update).toHaveBeenCalledWith({
            where: { id: "c1" },
            data: { vanishAfter: 604_800, rulesAgreedAt: null }
        });
        expect(notices[0]).toContain("set messages to disappear after 7 days");
    });

    it("agreement: a change is a proposal and the rules stay", async () => {
        settings.set("chat.dmRules", "agreement");
        await vanish.setVanishTimer(me, "c1", 86_400);
        expect(prisma.chatChannel.update).not.toHaveBeenCalled();
        expect(prisma.chatRuleProposal.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ vanishAfter: 86_400, acceptedBy: ["me"] })
        });
        expect(notices[0]).toContain("proposed");
    });

    it("agreement: delete for both is off with no agreement", async () => {
        settings.set("chat.dmRules", "agreement");
        await expect(vanish.deleteChatForAll(me, "c1")).rejects.toThrow("errors.deleteForAllOff");
    });

    it("only the other person may accept a proposal, and it then becomes the rules", async () => {
        settings.set("chat.dmRules", "agreement");
        proposal = pending();
        await expect(vanish.answerProposal(me, "p1", true)).rejects.toThrow(
            "errors.proposalNotYours"
        );
        await vanish.answerProposal(other, "p1", true);
        expect(tx.chatChannel.update).toHaveBeenCalledWith({
            where: { id: "c1" },
            data: expect.objectContaining({ vanishAfter: 86_400, deleteForAll: true })
        });
    });

    it("a declined proposal leaves the rules alone", async () => {
        settings.set("chat.dmRules", "agreement");
        proposal = pending();
        await vanish.answerProposal(other, "p1", false);
        expect(tx.chatChannel.update).not.toHaveBeenCalled();
        expect(notices[0]).toContain("declined");
    });

    it("a group's proposal waits for every member", async () => {
        settings.set("chat.dmRules", "agreement");
        channel.kind = "group";
        members = ["me", "other", "third"];
        proposal = pending();
        await vanish.answerProposal(other, "p1", true);
        expect(tx.chatChannel.update).not.toHaveBeenCalled();
    });

    it("two members accepting at once both count, and the last one settles it", async () => {
        settings.set("chat.dmRules", "agreement");
        channel.kind = "group";
        members = ["me", "other", "third"];
        proposal = pending();
        // Both read the proposal before either vote lands.
        prisma.chatRuleProposal.findUnique.mockImplementation(async () =>
            proposal ? { ...proposal, acceptedBy: ["me"] } : null
        );
        await Promise.all([
            vanish.answerProposal(other, "p1", true),
            vanish.answerProposal({ id: "third" }, "p1", true)
        ]);
        prisma.chatRuleProposal.findUnique.mockImplementation(async () => proposal);
        expect(proposal?.acceptedBy).toEqual(["me", "other", "third"]);
        expect(proposal?.status).toBe("accepted");
        expect(tx.chatChannel.update).toHaveBeenCalledTimes(1);
    });

    it("a vote already counted is not counted again", async () => {
        settings.set("chat.dmRules", "agreement");
        proposal = pending({ acceptedBy: ["me"] });
        prisma.chatRuleProposal.findUnique.mockImplementationOnce(async () => ({
            ...pending(),
            acceptedBy: []
        }));
        await expect(vanish.answerProposal(me, "p1", true)).rejects.toThrow("errors.proposalGone");
        expect(proposal?.acceptedBy).toEqual(["me"]);
    });

    it("a group with nobody else in it agrees as soon as it proposes", async () => {
        settings.set("chat.dmRules", "agreement");
        channel.kind = "group";
        members = ["me"];
        await vanish.proposeRules(me, "c1", { vanishAfter: 604_800, deleteForAll: true });
        expect(prisma.chatRuleProposal.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ status: "accepted" })
        });
        expect(prisma.chatChannel.update).toHaveBeenCalledWith({
            where: { id: "c1" },
            data: expect.objectContaining({ vanishAfter: 604_800, deleteForAll: true })
        });
        expect(notices[0]).toContain("accepted the chat rules");
    });

    it("going back to the open mode closes every proposal still waiting", async () => {
        await vanish.setDmRuleMode("open");
        expect(prisma.chatRuleProposal.updateMany).toHaveBeenCalledWith({
            where: { status: "pending" },
            data: expect.objectContaining({ status: "withdrawn" })
        });
    });

    it("an open-mode timer change closes what was proposed before it", async () => {
        await vanish.setVanishTimer(me, "c1", 86_400);
        expect(prisma.chatRuleProposal.updateMany).toHaveBeenCalledWith({
            where: { channelId: "c1", status: "pending" },
            data: expect.objectContaining({ status: "withdrawn" })
        });
    });

    it("a proposal cannot be answered in the open mode", async () => {
        proposal = pending();
        await expect(vanish.answerProposal(other, "p1", true)).rejects.toThrow(
            "errors.proposalGone"
        );
    });
});

describe("delete the chat", () => {
    it("for both: every message is expired at once and one line says who", async () => {
        await vanish.deleteChatForAll(me, "c1");
        expect(prisma.chatMessage.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: expect.objectContaining({ channelId: "c1" }) })
        );
        expect(notices).toEqual(["[Ada](polaris:user/me) deleted the chat"]);
    });

    it("for both, with the line turned off: no line", async () => {
        settings.set("chat.deleteChatLine", "off");
        await vanish.deleteChatForAll(me, "c1");
        expect(notices).toEqual([]);
    });

    it("for me: only my membership is cleared", async () => {
        await vanish.clearChatForMe(me, "c1");
        expect(prisma.chatChannelMember.updateMany).toHaveBeenCalledWith({
            where: { channelId: "c1", userId: "me" },
            data: expect.objectContaining({ clearedAt: expect.any(Date) })
        });
        expect(prisma.chatMessage.updateMany).not.toHaveBeenCalled();
    });
});

describe("the sweep", () => {
    it("deletes in bounded batches, files first, replies included", async () => {
        due = [
            [
                { id: "m1", channelId: "c1", parentId: null },
                { id: "m2", channelId: "c1", parentId: "root" }
            ]
        ];
        const removed = await vanish.sweepExpiredMessages(new Date(), 2, 3);
        expect(removed).toBe(2);
        expect(discarded).toEqual(["m1", "reply"]);
        expect(tx.chatMessage.deleteMany).toHaveBeenCalledWith({
            where: { id: { in: ["m1", "m2"] } }
        });
        // The root that stays loses the reply from its count.
        expect(tx.chatMessage.updateMany).toHaveBeenCalledWith({
            where: { id: "root", replyCount: { gte: 1 } },
            data: { replyCount: { decrement: 1 } }
        });
        const first = prisma.chatMessage.findMany.mock.calls[0]![0] as unknown as { take: number };
        expect(first.take).toBe(2);
    });

    it("stops after its last round", async () => {
        due = [
            [{ id: "a", channelId: "c1", parentId: null }],
            [{ id: "b", channelId: "c1", parentId: null }]
        ];
        expect(await vanish.sweepExpiredMessages(new Date(), 1, 1)).toBe(1);
    });
});

describe("the per-user default", () => {
    it("starts a new chat with its starter's default timer", async () => {
        prisma.userPrivacy.findUnique.mockResolvedValueOnce({ chatVanishAfter: 86_400 });
        await vanish.applyDefaultTimer(me, "c1");
        expect(prisma.chatChannel.update).toHaveBeenCalled();
    });
});
