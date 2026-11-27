import { beforeEach, describe, expect, it, vi } from "vitest";
import { encryptionModeOf, seatsAfter, PUBLIC_CHANNELS_OPEN, SEALED_MEMBER_CAP, SEALED_WARN_AT } from "@/lib/chat/e2ee/encryption-mode";

const db = vi.hoisted(() => ({
    served: true,
    channel: null as null | { kind: string; private: boolean; spaceId: string | null; e2eeMode: string | null; space: { visibility: string } | null },
    channelMembers: 0,
    space: null as null | { visibility: string },
    spaceMembers: 0
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        chatChannel: { findUnique: async () => db.channel },
        chatChannelMember: { count: async () => db.channelMembers },
        chatSpace: { findUnique: async () => db.space },
        chatSpaceMember: { count: async () => db.spaceMembers }
    }
}));
vi.mock("@/lib/chat/e2ee/flag", () => ({ sealedChatServed: () => db.served }));
vi.mock("@/lib/chat/notices", () => ({ postNoticeBody: async () => undefined, spaceNoticeChannel: async () => null }));

const { refuseSealedPastCap, sealedHeadcount } = await import("@/lib/chat/e2ee/encryption-policy");

describe("encryption mode from the join rule", () => {
    it("is held behind the public mode switch, which ships off", () => {
        expect(PUBLIC_CHANNELS_OPEN).toBe(false);
        // Off: every conversation is sealed, as before the policy.
        expect(encryptionModeOf({ kind: "text", private: false, spaceVisibility: "internal" })).toBe("sealed");
    });

    it("leaves only a channel anybody joins without an invitation in the clear", () => {
        const on = (rule: Parameters<typeof encryptionModeOf>[0]) => encryptionModeOf(rule, true);
        expect(on({ kind: "text", private: false, spaceVisibility: "internal" })).toBe("open");
        expect(on({ kind: "forum", private: false, spaceVisibility: "internal" })).toBe("open");
        expect(on({ kind: "text", private: true, spaceVisibility: "internal" })).toBe("sealed");
        expect(on({ kind: "text", private: false, spaceVisibility: "private" })).toBe("sealed");
        expect(on({ kind: "dm", private: true, spaceVisibility: null })).toBe("sealed");
        expect(on({ kind: "group", private: true, spaceVisibility: null })).toBe("sealed");
    });
});

describe("sealed member cap", () => {
    it("keeps a margin under the measured tree ceiling and warns at 80%", () => {
        // docs/chat-e2ee-mls.md row 12: 64 parts reach some 12,600 members with filled paths.
        expect(SEALED_MEMBER_CAP).toBe(10_000);
        expect(SEALED_MEMBER_CAP).toBeLessThan(12_600);
        expect(SEALED_WARN_AT).toBe(8_000);
    });

    it("refuses past the cap and warns once on crossing the line", () => {
        expect(seatsAfter(9_999, 1)).toEqual({ refused: false, warn: false });
        expect(seatsAfter(10_000, 1)).toEqual({ refused: true, warn: false });
        expect(seatsAfter(9_990, 20)).toEqual({ refused: true, warn: false });
        expect(seatsAfter(7_999, 1)).toEqual({ refused: false, warn: true });
        expect(seatsAfter(8_000, 1)).toEqual({ refused: false, warn: false });
        expect(seatsAfter(10_000, 0)).toEqual({ refused: false, warn: false });
    });

    beforeEach(() => {
        db.served = true;
        db.channel = null;
        db.space = null;
        db.channelMembers = 0;
        db.spaceMembers = 0;
    });

    it("refuses a join into a full private space with a readable reason, before anything is written", async () => {
        db.space = { visibility: "private" };
        db.spaceMembers = SEALED_MEMBER_CAP - 1; // and the owner
        await expect(refuseSealedPastCap({ spaceId: "s" }, 1)).rejects.toMatchObject({
            name: "ChatAccessError",
            text: { key: "errors.sealedGroupFull", params: { cap: SEALED_MEMBER_CAP } }
        });
        db.spaceMembers = SEALED_MEMBER_CAP - 2;
        await expect(refuseSealedPastCap({ spaceId: "s" }, 1)).resolves.toBe(false);
    });

    it("counts a private channel by its rows and a channel open to its space by the space", async () => {
        db.channel = { kind: "text", private: true, spaceId: "s", e2eeMode: null, space: { visibility: "private" } };
        db.channelMembers = 42;
        expect(await sealedHeadcount({ channelId: "c" })).toBe(42);
        db.channel = { kind: "text", private: false, spaceId: "s", e2eeMode: null, space: { visibility: "private" } };
        db.space = { visibility: "private" };
        db.spaceMembers = 7;
        expect(await sealedHeadcount({ channelId: "c" })).toBe(8);
    });

    it("caps nothing while sealed chat is off", async () => {
        db.served = false;
        db.space = { visibility: "private" };
        db.spaceMembers = SEALED_MEMBER_CAP * 2;
        await expect(refuseSealedPastCap({ spaceId: "s" }, 1)).resolves.toBe(false);
    });
});
