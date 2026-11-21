/**
 * Only whoever runs a conversation posts in it, when that switch is off.
 *
 * A group's owner, a space channel's administrators. The rule is one predicate
 * (`sendClosed`) asked by the send path and by the screen that draws the
 * composer, and `requirePostable` refuses with it while reactions and poll
 * votes stay open, the way an announcement group works.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let channel: Record<string, unknown> = {};
let membership: Record<string, unknown> | null = null;

vi.mock("@polaris/db", () => ({
    prisma: {
        chatChannel: { findUnique: vi.fn(async () => channel) },
        chatChannelMember: { findUnique: vi.fn(async () => membership) },
        chatSpaceMember: { findUnique: vi.fn(async () => null) }
    }
}));

const { requirePostable, sendClosed } = await import("@/lib/chat/access");

const GROUP = {
    id: "group-1",
    kind: "group",
    spaceId: null,
    ownerId: "ada",
    createdById: "ada",
    private: true,
    archived: false,
    space: null
};

beforeEach(() => {
    channel = { ...GROUP, membersMaySend: false };
    membership = { role: "member", timeoutUntil: null };
});

describe("who may post where only whoever runs it may", () => {
    it("is open everywhere the switch is on, which is every existing conversation", () => {
        for (const kind of ["dm", "group", "text"]) {
            const room = { kind, spaceId: kind === "text" ? "s1" : null, ownerId: "ada" };
            expect(sendClosed({ ...room, membersMaySend: true }, "grace", false)).toBe(false);
        }
    });

    it("leaves a group to its owner", () => {
        const group = { kind: "group", spaceId: null, ownerId: "ada", membersMaySend: false };
        expect(sendClosed(group, "ada", false)).toBe(false);
        expect(sendClosed(group, "grace", false)).toBe(true);
    });

    it("falls back to whoever started a group with no owner recorded", () => {
        const group = {
            kind: "group",
            spaceId: null,
            ownerId: null,
            createdById: "ada",
            membersMaySend: false
        };
        expect(sendClosed(group, "ada", false)).toBe(false);
        expect(sendClosed(group, "grace", false)).toBe(true);
    });

    it("leaves an announcement channel to the space's administrators", () => {
        const room = { kind: "text", spaceId: "s1", ownerId: null, membersMaySend: false };
        expect(sendClosed(room, "grace", true)).toBe(false);
        expect(sendClosed(room, "grace", false)).toBe(true);
    });

    it("never closes a direct message, which has nobody over it", () => {
        const dm = { kind: "dm", spaceId: null, ownerId: null, membersMaySend: false };
        expect(sendClosed(dm, "grace", false)).toBe(false);
    });
});

describe("posting in a group whose owner turned sending off", () => {
    it("refuses a member with its own sentence", async () => {
        await expect(requirePostable({ id: "grace" }, "group-1")).rejects.toMatchObject({
            text: { key: "errors.onlyAdminsSend" }
        });
    });

    it("lets a member react and vote", async () => {
        const access = await requirePostable({ id: "grace" }, "group-1", { reacting: true });
        expect(access.adminsOnly).toBe(true);
    });

    it("lets the owner post", async () => {
        const access = await requirePostable({ id: "ada" }, "group-1");
        expect(access.adminsOnly).toBe(false);
    });

    it("lets everybody post once it is back on", async () => {
        channel = { ...GROUP, membersMaySend: true };
        const access = await requirePostable({ id: "grace" }, "group-1");
        expect(access.adminsOnly).toBe(false);
    });
});
