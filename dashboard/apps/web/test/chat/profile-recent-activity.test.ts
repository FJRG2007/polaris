/**
 * What a profile's "Recent activity" may tell a reader.
 *
 * The list is built from records Polaris keeps (a visit to a game server here, a
 * game played together), so it says where somebody was and when. It has to obey
 * the same rules as what they are doing now: their `activity` audience, their
 * switch for sharing at all, the switch for each source - and, on top, nothing
 * while they chose to be invisible, because a visit that ended a minute ago says
 * they are around. Each refusal is asserted to also skip the read behind it, so
 * a refused reader never costs (or leaks through) a query.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NOW = new Date("2026-11-06T12:00:00Z");

/** Who is in grace's activity audience. */
let audience = new Set<string>();
let settings: core.ActivitySettings = core.DEFAULT_ACTIVITY_SETTINGS;
let presence: { presence: string; presenceUntil: Date | null } = {
    presence: "online",
    presenceUntil: null
};
/** Who asked the game servers app, so a refusal can be shown never to ask. */
let serverReads: string[] = [];
let seatReads: string[] = [];
/** The playtime kept per game the desktop app saw, as `UserGameTime` holds it. */
let played: { key: string; name: string; lastReportAt: Date }[] = [];
let playedReads: { userId: string; key?: { notIn: string[] } }[] = [];

vi.mock("@/lib/privacy-service", () => ({
    allowedBy: async (viewer: { id: string }, field: string, ids: readonly string[]) =>
        new Set(field === "activity" && audience.has(viewer.id) ? ids : [])
}));

vi.mock("@/lib/presence-activity/settings", () => ({
    activitySettingsFor: async (ids: readonly string[]) => new Map(ids.map((id) => [id, settings]))
}));

vi.mock("@/lib/i18n/locale-service", () => ({ getUserLocale: async () => "en-US" }));
vi.mock("@/lib/apps/install-presence", () => ({ isAppInstalled: async () => true }));

vi.mock("@/lib/app-extensions/registry", () => ({
    callActivityGames: async () => [{ id: "chess", name: "Chess" }],
    playedRecentlyFor: async (userId: string) => {
        serverReads.push(userId);
        return [
            {
                game: "Minecraft",
                server: "Survival",
                endedAt: new Date("2026-11-05T10:00:00Z"),
                installedAppId: "mc1",
                gameId: "minecraft",
                imageUrl: "/icon"
            }
        ];
    }
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        user: { findUnique: async () => presence },
        userGameTime: {
            findMany: async ({
                where,
                take
            }: {
                where: { userId: string; lastReportAt: { gte: Date }; key?: { notIn: string[] } };
                take: number;
            }) => {
                playedReads.push({ userId: where.userId, key: where.key });
                return played
                    .filter((row) => row.lastReportAt >= where.lastReportAt.gte)
                    .filter((row) => !where.key?.notIn.includes(row.key))
                    .sort((a, b) => b.lastReportAt.getTime() - a.lastReportAt.getTime())
                    .slice(0, take);
            }
        },
        gameArtKey: {
            findMany: async () => [{ key: "witcher3.exe", ref: "gog:1207664663" }]
        },
        arcadeSessionPlayer: {
            findMany: async ({ where }: { where: { userId: string } }) => {
                seatReads.push(where.userId);
                return [
                    { leftAt: new Date("2026-11-06T09:00:00Z"), session: { game: "chess" } },
                    { leftAt: new Date("2026-11-04T09:00:00Z"), session: { game: "chess" } },
                    // A game no longer offered is left out, never shown by its id.
                    { leftAt: new Date("2026-11-03T09:00:00Z"), session: { game: "gone" } }
                ];
            }
        }
    }
}));

const { recentActivityFor } = await import("@/lib/presence-activity/recent");

const ADA = { id: "ada", isAdmin: false };

beforeEach(() => {
    audience = new Set(["ada"]);
    settings = { ...core.DEFAULT_ACTIVITY_SETTINGS, share: true, minecraft: true, games: true };
    presence = { presence: "online", presenceUntil: null };
    serverReads = [];
    seatReads = [];
    played = [];
    playedReads = [];
});

describe("a reader in the activity audience", () => {
    it("is shown each source once, newest first", async () => {
        const list = await recentActivityFor(ADA, "grace", NOW);
        expect(list.map((entry) => entry.key)).toEqual(["arcade:chess", "server:mc1"]);
        expect(list[0]).toMatchObject({ name: "Chess", endedAt: "2026-11-06T09:00:00.000Z" });
        expect(list[1]).toMatchObject({ name: "Minecraft", details: "Survival" });
    });

    it("is not shown a source its owner switched off, and it is never read", async () => {
        settings = { ...settings, minecraft: false };
        const list = await recentActivityFor(ADA, "grace", NOW);
        expect(list.map((entry) => entry.source)).toEqual(["game"]);
        expect(serverReads).toEqual([]);
    });
});

describe("a game the desktop app saw running", () => {
    beforeEach(() => {
        played = [
            {
                key: "rocketleague.exe",
                name: "Rocket League",
                lastReportAt: new Date("2026-11-05T22:00:00Z")
            }
        ];
    });

    it("is listed once it ends, not only Minecraft server visits", async () => {
        const list = await recentActivityFor(ADA, "grace", NOW);
        expect(list.map((entry) => entry.key)).toEqual([
            "arcade:chess",
            "played:rocketleague.exe",
            "server:mc1"
        ]);
        expect(list[1]).toMatchObject({
            source: "game",
            name: "Rocket League",
            details: "",
            endedAt: "2026-11-05T22:00:00.000Z",
            imageUrl: expect.stringContaining("steam%3A252950")
        });
    });

    it("is drawn by the store id an earlier report taught for the program", async () => {
        played = [
            {
                key: "witcher3.exe",
                name: "The Witcher 3",
                lastReportAt: new Date("2026-11-06T08:00:00Z")
            }
        ];
        const [entry] = (await recentActivityFor(ADA, "grace", NOW)).filter(
            (item) => item.key === "played:witcher3.exe"
        );
        expect(entry?.imageUrl).toContain("gog");
    });

    it("is left out once hidden, by asking for it not to be read", async () => {
        settings = { ...settings, hiddenGames: ["rocketleague.exe"] };
        const list = await recentActivityFor(ADA, "grace", NOW);
        expect(list.map((entry) => entry.key)).not.toContain("played:rocketleague.exe");
        expect(playedReads[0]?.key).toEqual({ notIn: ["rocketleague.exe"] });
    });

    it("is not read while games are switched off", async () => {
        settings = { ...settings, games: false };
        const list = await recentActivityFor(ADA, "grace", NOW);
        expect(list.map((entry) => entry.source)).toEqual(["minecraft"]);
        expect(playedReads).toEqual([]);
    });

    it("gives way to the server visit when it was Minecraft", async () => {
        played = [
            { key: "javaw.exe", name: "Minecraft", lastReportAt: new Date("2026-11-05T10:00:00Z") },
            ...played
        ];
        const list = await recentActivityFor(ADA, "grace", NOW);
        expect(
            list.filter((entry) => entry.name === "Minecraft").map((entry) => entry.key)
        ).toEqual(["server:mc1"]);
        expect(list.map((entry) => entry.key)).toContain("played:rocketleague.exe");
    });

    it("is not listed past the recent window", async () => {
        played = [
            { key: "old.exe", name: "Old Game", lastReportAt: new Date("2026-07-01T00:00:00Z") }
        ];
        const list = await recentActivityFor(ADA, "grace", NOW);
        expect(list.map((entry) => entry.key)).not.toContain("played:old.exe");
    });
});

describe("what is refused, without reading anything behind it", () => {
    it("a reader outside the activity audience", async () => {
        audience = new Set();
        expect(await recentActivityFor(ADA, "grace", NOW)).toEqual([]);
        expect([...serverReads, ...seatReads, ...playedReads]).toEqual([]);
    });

    it("anybody, while sharing is switched off", async () => {
        settings = { ...settings, share: false };
        expect(await recentActivityFor(ADA, "grace", NOW)).toEqual([]);
        expect([...serverReads, ...seatReads, ...playedReads]).toEqual([]);
    });

    it("anybody else, while they are invisible", async () => {
        presence = { presence: "invisible", presenceUntil: null };
        expect(await recentActivityFor(ADA, "grace", NOW)).toEqual([]);
        expect([...serverReads, ...seatReads, ...playedReads]).toEqual([]);
    });
});

describe("invisible for a while", () => {
    it("is over once the time they set has passed", async () => {
        presence = { presence: "invisible", presenceUntil: new Date("2026-11-06T11:00:00Z") };
        expect(await recentActivityFor(ADA, "grace", NOW)).toHaveLength(2);
    });

    it("never hides their own list from themselves", async () => {
        audience = new Set();
        presence = { presence: "invisible", presenceUntil: null };
        const list = await recentActivityFor({ id: "grace", isAdmin: false }, "grace", NOW);
        expect(list).toHaveLength(2);
    });
});
