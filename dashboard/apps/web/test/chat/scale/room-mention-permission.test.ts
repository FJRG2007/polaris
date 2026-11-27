/**
 * `@everyone` and `@here` in a space are its admins' unless the space hands
 * them out, as Discord's "Mention @everyone": the send refuses a member, the
 * composer is not offered the words, and every existing space starts closed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const MEMBER = "00000000-0000-4000-8000-000000000001";
const OWNER = "00000000-0000-4000-8000-000000000002";
const SPACE = "00000000-0000-4000-8000-0000000000aa";

const state = vi.hoisted(() => ({ handedOut: false, role: "member" as string | null }));

vi.mock("@polaris/db", () => ({
    prisma: {
        chatChannel: {
            findUnique: async () => ({
                kind: "text",
                ownerId: null,
                createdById: null,
                membersMayMention: false,
                spaceId: "00000000-0000-4000-8000-0000000000aa",
                space: { membersMayMentionEveryone: state.handedOut }
            })
        },
        chatSpace: {
            findUnique: async () => ({
                ownerId: "00000000-0000-4000-8000-000000000002",
                orgId: null,
                visibility: "private"
            })
        },
        chatSpaceMember: {
            findUnique: async () => (state.role ? { role: state.role } : null)
        },
        accessGrant: { findMany: async () => [] }
    }
}));

import { refuseRoomMention } from "@/lib/chat/room-mentions";
import { roomMentionsAllowed, type ChannelAccess } from "@/lib/chat/access";

const access = { channelId: "c1", spaceId: SPACE, kind: "text" } as ChannelAccess;

beforeEach(() => {
    state.handedOut = false;
    state.role = "member";
});

describe("refuseRoomMention in a space", () => {
    it("refuses a member by default", async () => {
        await expect(refuseRoomMention({ id: MEMBER, isAdmin: false }, access, "@everyone hi")).rejects.toThrow();
    });

    it("lets an admin and the owner through", async () => {
        state.role = "admin";
        await expect(refuseRoomMention({ id: MEMBER, isAdmin: false }, access, "@here hi")).resolves.toBeUndefined();
        state.role = null;
        await expect(refuseRoomMention({ id: OWNER, isAdmin: false }, access, "@everyone hi")).resolves.toBeUndefined();
    });

    it("lets a member through once the space hands it out", async () => {
        state.handedOut = true;
        await expect(refuseRoomMention({ id: MEMBER, isAdmin: false }, access, "@everyone hi")).resolves.toBeUndefined();
    });

    it("reads nothing for a message that names nobody", async () => {
        await expect(refuseRoomMention({ id: MEMBER, isAdmin: false }, access, "hello")).resolves.toBeUndefined();
    });
});

describe("roomMentionsAllowed", () => {
    const channel = (handedOut: boolean) => ({
        kind: "text",
        ownerId: null,
        membersMayMention: false,
        spaceId: SPACE,
        space: { membersMayMentionEveryone: handedOut }
    });

    it("is what the composer is offered: admins only unless handed out", () => {
        expect(roomMentionsAllowed(channel(false), MEMBER)).toBe(false);
        expect(roomMentionsAllowed(channel(false), MEMBER, true)).toBe(true);
        expect(roomMentionsAllowed(channel(true), MEMBER)).toBe(true);
    });

    it("leaves a direct conversation and a group as they were", () => {
        expect(roomMentionsAllowed({ kind: "dm", ownerId: null, membersMayMention: false }, MEMBER)).toBe(true);
        expect(roomMentionsAllowed({ kind: "group", ownerId: OWNER, membersMayMention: false }, MEMBER)).toBe(false);
    });
});
