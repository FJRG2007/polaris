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

import * as core from "@polaris/core";
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
/** Which teams this reader is on, and which grants exist. Empty in every case
 *  but the two that are about being handed a space or a room. */
let teams: string[] = [];
let grants: Record<string, unknown>[] = [];

/** One grant row as the reader selects it. The schedule columns are spelled out
 *  because a real row always has them: leaving them off would send the resolver
 *  looking for a wall clock that nothing in these cases needs. */
function handedTo(
    subjectType: string,
    subjectId: string,
    principalType: string,
    principalId: string,
    capability: string
) {
    return {
        id: `${subjectType}:${subjectId}:${principalId}`,
        subjectType,
        subjectId,
        principalType,
        principalId,
        capability,
        startsAt: null,
        endsAt: null,
        days: core.EVERY_DAY,
        startMinute: null,
        endMinute: null,
        timeZone: "UTC",
        maxUses: null,
        uses: 0
    };
}

vi.mock("@/lib/orgs/org-service", () => ({
    memberOrgIds: async () => orgIds,
    // Read by the grant resolver, which is the fourth way into a space.
    teamIdsFor: async () => teams
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        // A grant is the last way in, asked about only when every other has
        // said no. Empty in every case but the two about being handed a space
        // or a room.
        accessGrant: {
            findMany: async ({
                where
            }: {
                where: { subjectType: string; subjectId?: string };
            }) =>
                grants.filter(
                    (row) =>
                        row.subjectType === where.subjectType &&
                        (where.subjectId === undefined || row.subjectId === where.subjectId)
                )
        },
        teamMember: { findMany: async () => [] },
        organizationMember: { findMany: async () => [] },
        orgRole: { findMany: async () => [] },
        chatSpace: {
            findUnique: async ({ where }: { where: { id: string } }) =>
                spaces.find((space) => space.id === where.id) ?? null,
            findMany: async ({ where }: { where: { OR: Record<string, unknown>[] } }) =>
                spaces
                    .filter((space) =>
                        where.OR.some((clause) => {
                            if ("ownerId" in clause) return space.ownerId === clause.ownerId;
                            if ("members" in clause) {
                                const userId = (clause.members as { some: { userId: string } }).some
                                    .userId;
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
    teams = [];
    grants = [];
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

    it("lets in a team the space was handed to, without a row per person", async () => {
        // The whole reason grants exist here: an organization gives a space to
        // its support team, and whoever joins that team later is in it.
        spaces = [{ id: "s1", ownerId: "other", orgId: "o1", visibility: "private" }];
        teams = ["team-support"];
        grants = [handedTo("chat.space", "s1", "team", "team-support", "member")];
        expect(await access.spaceAccess(me, "s1")).toBe("member");
    });

    it("stops letting them in the moment they leave that team", async () => {
        spaces = [{ id: "s1", ownerId: "other", orgId: "o1", visibility: "private" }];
        teams = [];
        grants = [handedTo("chat.space", "s1", "team", "team-support", "member")];
        expect(await access.spaceAccess(me, "s1")).toBeNull();
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

    it("opens one private room to a team without opening the space", async () => {
        // One room of a space handed to one team, which is what a grant on the
        // channel itself means - and a grant on the SPACE deliberately does not
        // do this: private means chosen.
        // Nobody's own space, no org of theirs, and nothing that would let them
        // reach it: the room is the whole of what they were handed.
        spaces = [{ id: "s1", ownerId: "other", orgId: "o1", visibility: "internal" }];
        orgIds = [];
        channels = [{ id: "c1", spaceId: "s1", kind: "text", private: true, archived: false }];
        teams = ["team-support"];
        grants = [handedTo("chat.channel", "c1", "team", "team-support", "member")];
        expect(await access.spaceAccess(me, "s1")).toBeNull();
        const reach = await access.channelAccess(me, "c1");
        expect(reach?.channelId).toBe("c1");
        // Reached without a membership row, so nothing here writes a read mark.
        expect(reach?.member).toBe(false);
        expect(reach?.mayPost).toBe(true);
        expect(reach?.mayAdminister).toBe(false);
    });

    it("opens a public room handed on its own, in a space that is not theirs", async () => {
        spaces = [{ id: "s1", ownerId: "other", orgId: "o1", visibility: "private" }];
        orgIds = [];
        channels = [{ id: "c1", spaceId: "s1", kind: "text", private: false, archived: false }];
        teams = ["team-support"];
        grants = [handedTo("chat.channel", "c1", "team", "team-support", "admin")];
        const reach = await access.channelAccess(me, "c1");
        expect(reach?.channelId).toBe("c1");
        expect(reach?.mayAdminister).toBe(true);
        // Everything the rail lists has to open, or the room is drawn and refuses.
        expect(await access.reachableChannelIds(me)).toContain("c1");
    });

    it("refuses a room in a space that is not theirs when nothing was handed over", async () => {
        spaces = [{ id: "s1", ownerId: "other", orgId: "o1", visibility: "private" }];
        orgIds = [];
        channels = [{ id: "c1", spaceId: "s1", kind: "text", private: false, archived: false }];
        expect(await access.channelAccess(me, "c1")).toBeNull();
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
