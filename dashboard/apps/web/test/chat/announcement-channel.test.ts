/**
 * An announcement channel is a type you pick, stored as the switch it always
 * was: a text channel with `membersMaySend` off. Channels made with the switch
 * are therefore announcement channels with no migration, and the two can never
 * disagree.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

let created: Record<string, unknown> = {};

vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: async () => [] }));

vi.mock("@polaris/db", () => ({
    prisma: {
        chatSpace: {
            findUnique: async () => ({ ownerId: "ada", orgId: null, visibility: "private" }),
            findMany: async () => [{ id: "space-1" }]
        },
        chatSpaceMember: { findUnique: async () => null },
        chatCategory: { findFirst: async () => ({ id: "category-1" }) },
        chatChannel: {
            findFirst: async () => null,
            create: async ({ data }: { data: Record<string, unknown> }) => {
                created = data;
                return { id: "channel-new" };
            }
        }
    }
}));

const chat = await import("@/lib/chat/chat-service");
const ada = { id: "ada" };

beforeEach(() => {
    created = {};
});

function input(over: Record<string, unknown>) {
    return core.chatChannelCreateSchema.parse({ spaceId: crypto.randomUUID(), name: "news", ...over });
}

describe("making an announcement channel", () => {
    it("stores it as a text channel members may not post in", async () => {
        await chat.createChannel(ada, input({ announcement: true }));
        expect(created).toMatchObject({ kind: "text", membersMaySend: false });
    });

    it("leaves an ordinary channel open to everybody", async () => {
        await chat.createChannel(ada, input({}));
        expect(created.kind).toBe("text");
        expect(created).not.toHaveProperty("membersMaySend");
    });

    it("refuses a voice channel that asks to be one", () => {
        expect(
            core.chatChannelCreateSchema.safeParse({
                spaceId: crypto.randomUUID(),
                name: "lounge",
                kind: "voice",
                announcement: true
            }).success
        ).toBe(false);
    });
});

describe("reading the type back", () => {
    it("is an announcement channel exactly when a space's text channel is closed to members", () => {
        expect(core.isAnnouncementChannel({ spaceId: "s", kind: "text", membersMaySend: false })).toBe(true);
        expect(core.isAnnouncementChannel({ spaceId: "s", kind: "text", membersMaySend: true })).toBe(false);
        expect(core.isAnnouncementChannel({ spaceId: "s", kind: "voice", membersMaySend: false })).toBe(false);
        // A group whose owner alone may send is still a group.
        expect(core.isAnnouncementChannel({ spaceId: null, kind: "group", membersMaySend: false })).toBe(false);
    });
});
