/**
 * "Playing Minecraft on <server>", from the visits the activity sweep keeps.
 *
 * What is pinned: a visit counts for an account only through a link the account
 * agrees with - a server it owns, its connected Minecraft name, or a link that
 * follows its sign-ins - because an operator's word alone is not enough to
 * publish where somebody is; only a visit that is still open counts; names are
 * matched whatever their case; and a server that is not Minecraft, or has been
 * removed, says nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ADA = "ada";
const JOINED = new Date("2026-09-28T10:00:00.000Z");

const fake = vi.hoisted(() => ({
    links: [] as {
        installedAppId: string;
        player: string;
        userId: string;
        followSignIns: boolean;
    }[],
    installs: [] as {
        id: string;
        ownerId: string;
        catalogId: string;
        name: string;
        status: string;
    }[],
    connections: [] as { userId: string; label: string }[],
    sessions: [] as { installedAppId: string; name: string; joinedAt: Date; leftAt: Date | null }[]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        gamePlayerLink: {
            findMany: async ({
                where
            }: {
                where: { userId?: { in: string[] }; installedAppId?: string };
            }) =>
                fake.links.filter(
                    (link) =>
                        (!where.userId || where.userId.in.includes(link.userId)) &&
                        (!where.installedAppId || link.installedAppId === where.installedAppId)
                )
        },
        installedApp: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                fake.installs.filter(
                    (install) => where.id.in.includes(install.id) && install.status !== "removed"
                )
        },
        userConnection: {
            findMany: async ({
                where
            }: {
                where: { userId: { in: string[] }; provider: string };
            }) =>
                where.provider === "minecraft"
                    ? fake.connections.filter((connection) =>
                          where.userId.in.includes(connection.userId)
                      )
                    : []
        },
        gamePlayerSession: {
            findMany: async ({ where }: { where: { installedAppId: { in: string[] } } }) =>
                fake.sessions.filter(
                    (visit) =>
                        where.installedAppId.in.includes(visit.installedAppId) &&
                        visit.leftAt === null
                )
        }
    }
}));

const { playingMinecraftNow, accountsOfPlayers } = await import(
    "@polaris-app/game-servers/src/lib/minecraft/playing-now"
);

beforeEach(() => {
    fake.links = [];
    fake.connections = [];
    fake.installs = [
        { id: "s1", ownerId: "owner", catalogId: "minecraft", name: "Survival", status: "running" },
        { id: "gone", ownerId: "owner", catalogId: "minecraft", name: "Old", status: "removed" }
    ];
    fake.sessions = [{ installedAppId: "s1", name: "AdaPlays", joinedAt: JOINED, leftAt: null }];
});

describe("who is playing on a server here", () => {
    it("is an account whose link follows its sign-ins, with the server's name", async () => {
        fake.links = [
            { installedAppId: "s1", player: "adaplays", userId: ADA, followSignIns: true }
        ];
        expect(await playingMinecraftNow([ADA])).toEqual([
            { userId: ADA, game: "Minecraft", server: "Survival", since: JOINED }
        ]);
    });

    it("is an account whose connected Minecraft name is the player", async () => {
        fake.links = [
            { installedAppId: "s1", player: "AdaPlays", userId: ADA, followSignIns: false }
        ];
        fake.connections = [{ userId: ADA, label: "adaplays" }];
        expect(await playingMinecraftNow([ADA])).toHaveLength(1);
    });

    it("is not an account that only an operator says is that player", async () => {
        fake.links = [
            { installedAppId: "s1", player: "AdaPlays", userId: ADA, followSignIns: false }
        ];
        expect(await playingMinecraftNow([ADA])).toEqual([]);
    });

    it("is nobody once the visit has closed, or on a removed server", async () => {
        fake.links = [
            { installedAppId: "s1", player: "AdaPlays", userId: ADA, followSignIns: true },
            { installedAppId: "gone", player: "AdaPlays", userId: ADA, followSignIns: true }
        ];
        fake.sessions = [
            { installedAppId: "s1", name: "AdaPlays", joinedAt: JOINED, leftAt: new Date() },
            { installedAppId: "gone", name: "AdaPlays", joinedAt: JOINED, leftAt: null }
        ];
        expect(await playingMinecraftNow([ADA])).toEqual([]);
    });

    it("is nobody on a server that is not Minecraft", async () => {
        fake.installs = [
            { id: "s1", ownerId: "owner", catalogId: "ark", name: "Island", status: "running" }
        ];
        fake.links = [
            { installedAppId: "s1", player: "AdaPlays", userId: ADA, followSignIns: true }
        ];
        expect(await playingMinecraftNow([ADA])).toEqual([]);
    });
});

describe("whose screens are told a player arrived", () => {
    it("is every account linked to that name on that server", async () => {
        fake.links = [
            { installedAppId: "s1", player: "AdaPlays", userId: ADA, followSignIns: false },
            { installedAppId: "s1", player: "Other", userId: "bob", followSignIns: true }
        ];
        expect(await accountsOfPlayers("s1", ["adaplays"])).toEqual([ADA]);
        expect(await accountsOfPlayers("s1", [])).toEqual([]);
    });
});
