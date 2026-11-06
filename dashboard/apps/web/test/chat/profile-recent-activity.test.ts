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

describe("what is refused, without reading anything behind it", () => {
    it("a reader outside the activity audience", async () => {
        audience = new Set();
        expect(await recentActivityFor(ADA, "grace", NOW)).toEqual([]);
        expect([...serverReads, ...seatReads]).toEqual([]);
    });

    it("anybody, while sharing is switched off", async () => {
        settings = { ...settings, share: false };
        expect(await recentActivityFor(ADA, "grace", NOW)).toEqual([]);
        expect([...serverReads, ...seatReads]).toEqual([]);
    });

    it("anybody else, while they are invisible", async () => {
        presence = { presence: "invisible", presenceUntil: null };
        expect(await recentActivityFor(ADA, "grace", NOW)).toEqual([]);
        expect([...serverReads, ...seatReads]).toEqual([]);
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
