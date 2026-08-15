/**
 * Who gets into a conversation.
 *
 * This is the file to be paranoid in. Everywhere else in Polaris the expensive
 * failure is somebody being locked out of their own work; in chat it is somebody
 * reading a room they were not in, and no amount of "it looked right" makes that
 * recoverable. So each way in is asserted, and so is each way that must not
 * work - a private channel without a row, a direct message somebody merely
 * shares a space with, an organization space belonging to an organization the
 * reader is not on.
 *
 * There is deliberately no administrator case, because there is deliberately no
 * administrator override.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface SpaceRow {
    id: string;
    ownerId: string;
    orgId: string | null;
    visibility: string;
    archived?: boolean;
}

interface ChannelRow {
    id: string;
    spaceId: string | null;
    kind: string;
    private: boolean;
    archived: boolean;
}

let spaces: SpaceRow[] = [];
let spaceMembers: { spaceId: string; userId: string; role: string }[] = [];
let channels: ChannelRow[] = [];
let channelMembers: { channelId: string; userId: string; role: string }[] = [];
let orgIds: string[] = [];

vi.mock("@/lib/orgs/org-service", () => ({
    memberOrgIds: async () => orgIds
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        chatSpace: {
            findUnique: async ({ where }: { where: { id: string } }) =>
                spaces.find((space) => space.id === where.id) ?? null,
            findMany: async ({ where }: { where: { OR: Record<string, unknown>[] } }) =>
                spaces
                    .filter((space) =>
                        where.OR.some((clause) => {
                            if ("ownerId" in clause) return space.ownerId === clause.ownerId;
                            if ("members" in clause) {
                                const userId = (
                                    clause.members as { some: { userId: string } }
                                ).some.userId;
                                return spaceMembers.some(
                                    (row) => row.spaceId === space.id && row.userId === userId
                                );
                            }
                            if (clause.visibility !== space.visibility) return false;
                            if (clause.orgId === null) return space.orgId === null;
                            const wanted = (clause.orgId as { in: string[] }).in;
                            return space.orgId !== null && wanted.includes(space.orgId);
                        })
                    )
                    .map((space) => ({ id: space.id }))
        },
        chatSpaceMember: {
            findUnique: async ({
                where
            }: {
                where: { spaceId_userId: { spaceId: string; userId: string } };
            }) =>
                spaceMembers.find(
                    (row) =>
                        row.spaceId === where.spaceId_userId.spaceId &&
                        row.userId === where.spaceId_userId.userId
                ) ?? null
        },
        chatChannel: {
            findUnique: async ({ where }: { where: { id: string } }) => {
                const channel = channels.find((entry) => entry.id === where.id);
                if (!channel) return null;
                const space = channel.spaceId
                    ? spaces.find((entry) => entry.id === channel.spaceId)
                    : null;
                return { ...channel, space: space ? { archived: space.archived ?? false } : null };
            },
            findMany: async ({ where }: { where: { spaceId: { in: string[] } } }) =>
                channels
                    .filter(
                        (channel) =>
                            channel.spaceId !== null &&
                            where.spaceId.in.includes(channel.spaceId) &&
                            !channel.private
                    )
                    .map((channel) => ({ id: channel.id }))
        },
        chatChannelMember: {
            findUnique: async ({
                where
            }: {
                where: { channelId_userId: { channelId: string; userId: string } };
            }) =>
                channelMembers.find(
                    (row) =>
                        row.channelId === where.channelId_userId.channelId &&
                        row.userId === where.channelId_userId.userId
                ) ?? null,
            findMany: async ({ where }: { where: { userId: string } }) =>
                channelMembers
                    .filter((row) => row.userId === where.userId)
                    .map((row) => ({ channelId: row.channelId }))
        }
    }
}));

const access = await import("../../src/lib/chat/access");

const me = { id: "me" };

beforeEach(() => {
    spaces = [];
    spaceMembers = [];
    channels = [];
    channelMembers = [];
    orgIds = [];
});

describe("reaching a space", () => {
    it("lets the owner in, above every role", async () => {
        spaces = [{ id: "s1", ownerId: "me", orgId: null, visibility: "private" }];
        expect(await access.spaceAccess(me, "s1")).toBe("owner");
    });

    it("lets a member in at their stored role", async () => {
        spaces = [{ id: "s1", ownerId: "other", orgId: null, visibility: "private" }];
        spaceMembers = [{ spaceId: "s1", userId: "me", role: "admin" }];
        expect(await access.spaceAccess(me, "s1")).toBe("admin");
    });

    it("keeps a stranger out of a private space", async () => {
        spaces = [{ id: "s1", ownerId: "other", orgId: null, visibility: "private" }];
        expect(await access.spaceAccess(me, "s1")).toBeNull();
    });

    it("lets anybody into an internal space that belongs to no organization", async () => {
        spaces = [{ id: "s1", ownerId: "other", orgId: null, visibility: "internal" }];
        expect(await access.spaceAccess(me, "s1")).toBe("member");
    });

    it("holds an internal organization space to that organization's roster", async () => {
        spaces = [{ id: "s1", ownerId: "other", orgId: "acme", visibility: "internal" }];
        expect(await access.spaceAccess(me, "s1")).toBeNull();

        orgIds = ["acme"];
        expect(await access.spaceAccess(me, "s1")).toBe("member");
    });

    it("refuses an admin action to somebody who is only a member", async () => {
        spaces = [{ id: "s1", ownerId: "other", orgId: null, visibility: "internal" }];
        await expect(access.requireSpace(me, "s1", "admin")).rejects.toThrow(
            access.ChatAccessError
        );
    });
});

describe("reaching a channel", () => {
    it("opens a public channel to anybody in the space", async () => {
        spaces = [{ id: "s1", ownerId: "other", orgId: null, visibility: "internal" }];
        channels = [{ id: "c1", spaceId: "s1", kind: "text", private: false, archived: false }];

        const resolved = await access.channelAccess(me, "c1");
        expect(resolved?.mayPost).toBe(true);
        // Reached through the space, so there is no row and nothing to mark read
        // until they say something.
        expect(resolved?.member).toBe(false);
    });

    it("keeps a private channel shut to somebody who is in the space", async () => {
        spaces = [{ id: "s1", ownerId: "other", orgId: null, visibility: "internal" }];
        channels = [{ id: "c1", spaceId: "s1", kind: "text", private: true, archived: false }];

        expect(await access.channelAccess(me, "c1")).toBeNull();

        channelMembers = [{ channelId: "c1", userId: "me", role: "member" }];
        expect((await access.channelAccess(me, "c1"))?.member).toBe(true);
    });

    it("opens a direct message only to the people in it", async () => {
        channels = [{ id: "d1", spaceId: null, kind: "dm", private: true, archived: false }];
        expect(await access.channelAccess(me, "d1")).toBeNull();

        channelMembers = [{ channelId: "d1", userId: "me", role: "member" }];
        const resolved = await access.channelAccess(me, "d1");
        expect(resolved?.member).toBe(true);
        // Nobody administers a direct message: there is nothing in it to rename
        // and nobody to remove.
        expect(resolved?.mayAdminister).toBe(false);
    });

    it("still reads an archived channel, and refuses to post in one", async () => {
        spaces = [{ id: "s1", ownerId: "me", orgId: null, visibility: "private" }];
        channels = [{ id: "c1", spaceId: "s1", kind: "text", private: false, archived: true }];

        const resolved = await access.channelAccess(me, "c1");
        expect(resolved).not.toBeNull();
        expect(resolved?.mayPost).toBe(false);
        await expect(access.requirePostable(me, "c1")).rejects.toThrow("archived");
    });

    it("closes every channel in an archived space to writing", async () => {
        spaces = [{ id: "s1", ownerId: "me", orgId: null, visibility: "private", archived: true }];
        channels = [{ id: "c1", spaceId: "s1", kind: "text", private: false, archived: false }];

        expect((await access.channelAccess(me, "c1"))?.mayPost).toBe(false);
    });

    it("makes a space owner an administrator of its channels", async () => {
        spaces = [{ id: "s1", ownerId: "me", orgId: null, visibility: "private" }];
        channels = [{ id: "c1", spaceId: "s1", kind: "text", private: false, archived: false }];

        expect((await access.channelAccess(me, "c1"))?.mayAdminister).toBe(true);
    });
});

describe("what the live stream is allowed to tell somebody", () => {
    it("is exactly the channels they are in, plus the open ones of their spaces", async () => {
        spaces = [
            { id: "mine", ownerId: "me", orgId: null, visibility: "private" },
            { id: "theirs", ownerId: "other", orgId: null, visibility: "private" }
        ];
        channels = [
            { id: "open", spaceId: "mine", kind: "text", private: false, archived: false },
            { id: "shut", spaceId: "mine", kind: "text", private: true, archived: false },
            { id: "elsewhere", spaceId: "theirs", kind: "text", private: false, archived: false },
            { id: "dm", spaceId: null, kind: "dm", private: true, archived: false }
        ];
        channelMembers = [{ channelId: "dm", userId: "me", role: "member" }];

        const reachable = await access.reachableChannelIds(me);

        expect([...reachable].sort()).toEqual(["dm", "open"]);
    });
});
