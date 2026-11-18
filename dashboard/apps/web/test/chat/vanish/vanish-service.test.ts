import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = new Map<string, string>();
const channel = {
    id: "c1",
    kind: "dm",
    spaceId: null as string | null,
    ownerId: "me" as string | null,
    createdById: "me" as string | null,
    vanishAfter: 0,
    deleteForAll: false,
    rulesAgreedAt: null as Date | null,
    receipts: "follow",
    typing: "follow"
};
/** The reader's role in a group. */
let role = "member";
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
        findUnique: vi.fn(async () => ({ role })),
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
        ownerId: "me",
        createdById: "me",
        vanishAfter: 0,
        deleteForAll: false,
        rulesAgreedAt: null,
        receipts: "follow",
        typing: "follow"
    });
    role = "member";
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

    it("a group's proposal left from before its admins decided alone is not answerable", async () => {
        settings.set("chat.dmRules", "agreement");
        channel.kind = "group";
        members = ["me", "other", "third"];
        proposal = pending();
        await expect(vanish.answerProposal(other, "p1", true)).rejects.toThrow("errors.proposalGone");
        expect(tx.chatChannel.update).not.toHaveBeenCalled();
    });

    it("two members accepting at once both count, and the last one settles it", async () => {
        // The vote is appended in SQL however many it waits on; three members
        // are what make two answers at once possible.
        settings.set("chat.dmRules", "agreement");
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

    it("a group never proposes: its owner's rules apply at once", async () => {
        settings.set("chat.dmRules", "agreement");
        channel.kind = "group";
        members = ["me"];
        await vanish.proposeRules(me, "c1", { vanishAfter: 604_800, deleteForAll: true });
        expect(prisma.chatRuleProposal.create).not.toHaveBeenCalled();
        expect(prisma.chatChannel.update).toHaveBeenCalledWith({
            where: { id: "c1" },
            data: expect.objectContaining({ vanishAfter: 604_800, deleteForAll: true })
        });
        expect(notices[0]).toContain("set the chat rules");
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
describe("a chat's own read receipts and typing", () => {
    it("announced: either person in a one-to-one changes it at once, with a line", async () => {
        await vanish.changeRules(other, "c1", { receipts: "off" });
        expect(prisma.chatChannel.update).toHaveBeenCalledWith({
            where: { id: "c1" },
            data: { receipts: "off", rulesAgreedAt: null }
        });
        expect(notices[0]).toContain("turned read receipts off for everyone in this chat");
    });

    it("announced: a value it already has writes nothing and says nothing", async () => {
        channel.typing = "on";
        await vanish.changeRules(me, "c1", { typing: "on" });
        expect(prisma.chatChannel.update).not.toHaveBeenCalled();
        expect(notices).toEqual([]);
    });

    it("agreement: a change is a proposal carrying the whole rule set", async () => {
        settings.set("chat.dmRules", "agreement");
        await vanish.changeRules(me, "c1", { typing: "off" });
        expect(prisma.chatChannel.update).not.toHaveBeenCalled();
        expect(prisma.chatRuleProposal.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                proposedById: "me",
                typing: "off",
                receipts: "follow",
                vanishAfter: 0,
                acceptedBy: ["me"]
            })
        });
        expect(notices[0]).toContain("proposed");
        expect(notices[0]).toContain("typing indicator off");
    });

    it("agreement: accepting applies receipts and typing too, and says so", async () => {
        settings.set("chat.dmRules", "agreement");
        proposal = pending({ receipts: "on", typing: "off", vanishAfter: 0, deleteForAll: false });
        await vanish.answerProposal(other, "p1", true);
        expect(tx.chatChannel.update).toHaveBeenCalledWith({
            where: { id: "c1" },
            data: expect.objectContaining({ receipts: "on", typing: "off" })
        });
        expect(notices[0]).toContain("read receipts on, typing indicator off");
    });

    it("agreement: declining changes nothing and is announced", async () => {
        settings.set("chat.dmRules", "agreement");
        proposal = pending({ receipts: "on" });
        await vanish.answerProposal(other, "p1", false);
        expect(tx.chatChannel.update).not.toHaveBeenCalled();
        expect(prisma.chatChannel.update).not.toHaveBeenCalled();
        expect(notices[0]).toContain("declined");
    });

    it("agreement: the proposer withdraws it, nobody else may", async () => {
        settings.set("chat.dmRules", "agreement");
        proposal = { ...pending(), proposedById: "me" };
        await expect(vanish.withdrawProposal(other, "p1")).rejects.toThrow("errors.proposalNotYours");
        await vanish.withdrawProposal(me, "p1");
        expect(prisma.chatRuleProposal.updateMany).toHaveBeenCalledWith({
            where: { id: "p1", status: "pending" },
            data: expect.objectContaining({ status: "withdrawn" })
        });
        expect(notices.at(-1)).toContain("withdrew the proposed chat rules");
    });

    it("agreement: a settled proposal cannot be withdrawn", async () => {
        settings.set("chat.dmRules", "agreement");
        proposal = { ...pending({ status: "accepted" }), proposedById: "me" };
        await expect(vanish.withdrawProposal(me, "p1")).rejects.toThrow("errors.proposalGone");
    });

    it("a group: a member who does not run it is refused, in either mode", async () => {
        channel.kind = "group";
        channel.ownerId = "somebody-else";
        await expect(vanish.changeRules(me, "c1", { receipts: "on" })).rejects.toThrow(
            "errors.rulesGroupAdminsOnly"
        );
        settings.set("chat.dmRules", "agreement");
        await expect(vanish.changeRules(me, "c1", { receipts: "on" })).rejects.toThrow(
            "errors.rulesGroupAdminsOnly"
        );
        await expect(vanish.setVanishTimer(me, "c1", 86_400)).rejects.toThrow(
            "errors.rulesGroupAdminsOnly"
        );
        expect(prisma.chatChannel.update).not.toHaveBeenCalled();
    });

    it("a group: an admin changes it at once even in the agreement mode, and it counts as agreed", async () => {
        settings.set("chat.dmRules", "agreement");
        channel.kind = "group";
        channel.ownerId = "somebody-else";
        role = "admin";
        await vanish.changeRules(me, "c1", { typing: "off" });
        expect(prisma.chatRuleProposal.create).not.toHaveBeenCalled();
        expect(prisma.chatChannel.update).toHaveBeenCalledWith({
            where: { id: "c1" },
            data: { typing: "off", rulesAgreedAt: expect.any(Date) }
        });
        expect(notices[0]).toContain("turned the typing indicator off");
    });

    it("refuses a value that is not a rule", async () => {
        await expect(
            vanish.changeRules(me, "c1", { receipts: "maybe" as unknown as "on" })
        ).rejects.toThrow("errors.rulesBadValue");
    });

    it("tells readers the rules in force, and who may change them", async () => {
        channel.kind = "group";
        channel.ownerId = "somebody-else";
        channel.receipts = "on";
        const seen = await vanish.directRulesFor(me, "c1");
        expect(seen).toMatchObject({ receipts: "on", typing: "follow", mayChange: false, proposes: false });
    });

    it("the timer a chat sets is stamped on what is sent in it", async () => {
        channel.vanishAfter = 86_400;
        const sent = new Date("2026-11-18T10:00:00Z");
        expect(await vanish.expiryForChannel("c1", sent)).toEqual(new Date("2026-11-19T10:00:00Z"));
        settings.set("chat.dmRules", "agreement");
        expect(await vanish.expiryForChannel("c1", sent)).toBeNull();
    });
});

describe("the administrator's starting rules", () => {
    it("start a new chat with the chosen receipts, typing and timer, agreed", async () => {
        await vanish.setStartingRules({ receipts: "on", typing: "off", vanishAfter: 604_800 });
        await vanish.applyDefaultTimer(me, "c1");
        expect(prisma.chatChannel.update).toHaveBeenCalledWith({
            where: { id: "c1" },
            data: { receipts: "on", typing: "off", vanishAfter: 604_800, rulesAgreedAt: expect.any(Date) }
        });
        // The administrator's timer wins over the starter's own default.
        expect(prisma.userPrivacy.findUnique).not.toHaveBeenCalled();
    });

    it("left at their defaults, write nothing and keep the starter's own timer", async () => {
        await vanish.setStartingRules({ receipts: "follow", typing: "follow", vanishAfter: null });
        expect(settings.size).toBe(0);
        expect(await vanish.startingRules()).toEqual({ receipts: "follow", typing: "follow", vanishAfter: null });
        prisma.userPrivacy.findUnique.mockResolvedValueOnce({ chatVanishAfter: 86_400 });
        await vanish.applyDefaultTimer(me, "c1");
        expect(prisma.chatChannel.update).toHaveBeenCalledTimes(1);
        expect(prisma.chatChannel.update).toHaveBeenCalledWith({
            where: { id: "c1" },
            data: { vanishAfter: 86_400, rulesAgreedAt: null }
        });
    });

    it("ignore a stored timer that is not one of the durations", async () => {
        settings.set("chat.defaults.vanishAfter", "3600");
        expect((await vanish.startingRules()).vanishAfter).toBeNull();
    });
});

describe("which rule each conversation has", () => {
    it("reads many in one query, and a space's channel follows the accounts", async () => {
        const findMany = vi.fn(async () => [
            { ...channel, id: "a", receipts: "on", typing: "off" },
            { ...channel, id: "b", spaceId: "s1", receipts: "off" }
        ]);
        (prisma.chatChannel as unknown as { findMany: typeof findMany }).findMany = findMany;
        const found = await vanish.chatPrivacyIn(["a", "b", "a"]);
        expect(findMany).toHaveBeenCalledTimes(1);
        expect(found.get("a")).toEqual({ receipts: "on", typing: "off" });
        expect(found.has("b")).toBe(false);
    });
});
