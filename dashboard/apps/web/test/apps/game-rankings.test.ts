/**
 * Leaderboards on the side panel: top levels of who is on, and most deaths,
 * kills, player kills and time played from the game's own figures.
 *
 * What is pinned: a ranking is best first, numbered, and leaves out whoever is
 * at zero; time reads in hours; several lists on one panel share the room the
 * other lines leave; the figures come from the reader given and are not asked
 * for when no text uses a ranking; and inline a ranking names its top five.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({
    prisma: { installedApp: { findUnique: async () => ({ name: "Survival", config: "{}" }) } }
}));
vi.mock("@polaris/app-host", () => ({
    host: {
        appsInstallConfig: {
            readInstallConfig: (raw: string) => JSON.parse(raw ?? "{}"),
            patchInstallConfig: async () => undefined
        },
        chatCalls: { voicePresence: async () => new Map() }
    }
}));

const { playedText, rankLines, spreadListLines, statsRanking } = await import(
    "@polaris-app/game-servers/src/lib/minecraft/rankings"
);
const { liveContext } = await import("@polaris-app/game-servers/src/lib/minecraft/live-values");
const { sidebarProblems, DEFAULT_SIDEBAR, plainLine } = await import(
    "@polaris-app/game-servers/src/lib/minecraft/sidebar"
);

const HOUR = 3_600_000;
const figures = [
    { name: "Steve", stats: { playedMs: 120 * HOUR, deaths: 42, mobKills: 640, playerKills: 4 } },
    { name: "Alex", stats: { playedMs: 86 * HOUR, deaths: 30, mobKills: 812, playerKills: 9 } },
    { name: "Zed", stats: { playedMs: 40 * 60_000, deaths: 0, mobKills: 3, playerKills: 0 } }
];

describe("a ranking", () => {
    it("is best first, numbered, and leaves out whoever is at zero", () => {
        expect(statsRanking("rank.deaths", figures)).toEqual(["1. Steve 42", "2. Alex 30"]);
        expect(statsRanking("rank.kills", figures)).toEqual([
            "1. Alex 812",
            "2. Steve 640",
            "3. Zed 3"
        ]);
        expect(statsRanking("rank.pvp", figures)).toEqual(["1. Alex 9", "2. Steve 4"]);
    });

    it("reads time played stepped up its units: minutes, hours, days and on", () => {
        expect(statsRanking("rank.playtime", figures)).toEqual([
            "1. Steve 5 d",
            "2. Alex 3.6 d",
            "3. Zed 40 min"
        ]);
        expect(playedText(59 * 60_000)).toBe("59 min");
    });

    it("orders a tie by name", () => {
        expect(
            rankLines([
                { name: "Bob", value: 5 },
                { name: "Amy", value: 5 }
            ])
        ).toEqual(["1. Amy 5", "2. Bob 5"]);
    });
});

describe("lists on the side panel", () => {
    it("share the room the other lines leave", () => {
        const lines = ["&6Most deaths", "&c{rank.deaths}", "&6Top levels", "&a{rank.level}"];
        const lists = {
            "rank.deaths": ["1. A 9", "2. B 8", "3. C 7", "4. D 6", "5. E 5", "6. F 4", "7. G 3"],
            "rank.level": ["1. A 30", "2. B 20", "3. C 10", "4. D 5", "5. E 4", "6. F 3", "7. G 2"]
        };
        // Fifteen lines, two headings: thirteen left, six a list.
        const shown = spreadListLines(lines, lists, 15);
        expect(shown).toHaveLength(14);
        expect(shown.slice(0, 3)).toEqual(["&6Most deaths", "&c1. A 9", "&c2. B 8"]);
        expect(shown.filter((line) => line.startsWith("&c"))).toHaveLength(6);
        expect(shown.filter((line) => line.startsWith("&a"))).toHaveLength(6);
        // A ranking is a top: it stops rather than counting what did not fit.
        expect(shown.some((line) => line.includes("more"))).toBe(false);
    });

    it("are accepted on the panel", () => {
        const lines = [
            "{rank.deaths}",
            "{rank.kills}",
            "{rank.pvp}",
            "{rank.playtime}",
            "{rank.level}"
        ];
        expect(
            sidebarProblems({ ...DEFAULT_SIDEBAR, enabled: true, lines: lines.map(plainLine) })
                .lines
        ).toEqual([[null], [null], [null], [null], [null]]);
    });
});

describe("filling them in", () => {
    it("reads the figures from the reader given, top five inline", async () => {
        const many = Array.from({ length: 8 }, (_, index) => ({
            name: `P${index}`,
            stats: { playedMs: 0, deaths: 10 - index, mobKills: 0, playerKills: 0 }
        }));
        const context = await liveContext(
            "install",
            ["{rank.deaths}"],
            null,
            null,
            async () => many
        );
        expect(context.lists?.["rank.deaths"]).toHaveLength(8);
        expect(context.values["rank.deaths"]).toBe("1. P0 10, 2. P1 9, 3. P2 8, 4. P3 7, 5. P4 6");
    });

    it("does not ask for the figures when nothing reads a ranking", async () => {
        const read = vi.fn(async () => figures);
        await liveContext("install", ["Online: {server.online}"], null, null, read);
        expect(read).not.toHaveBeenCalled();
    });

    it("ranks levels from who is on", async () => {
        const server = {
            say: async () =>
                "Steve has the following entity data: 12\nAlex has the following entity data: 30",
            run: async () => ({ code: 1, output: "" })
        };
        const context = await liveContext("install", ["{rank.level}"], null, server);
        expect(context.lists?.["rank.level"]).toEqual(["1. Alex 30", "2. Steve 12"]);
    });
});
