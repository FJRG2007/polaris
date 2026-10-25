/**
 * Ranks as the server is sent them, and as they are read back from it.
 *
 * Pinned: the schema normalizes and refuses what a command cannot carry; the
 * prefix is a JSON component whose escaping comes from JSON itself; the exact
 * command list an apply sends, in order, including undoing what the last apply
 * did; the join commands; and reading teams out of a real scoreboard.dat shape,
 * old (JSON strings) and new (compounds).
 */

import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { english } from "../setup/game-english";
import {
    joinCommands,
    prefixComponent,
    rankCommands,
    rankId,
    ranksFromTeams,
    ranksSchema,
    readRanks,
    replacedTeams,
    teamName,
    teamsFromScoreboard,
    appliedBy,
    type Rank
} from "@polaris-app/game-servers/src/lib/minecraft/ranks";
import { readNbt } from "@polaris-app/game-servers/src/lib/minecraft/nbt";

const ADMIN: Rank = {
    id: "admin",
    name: "Admin",
    tag: "ADMIN",
    symbol: "⚔",
    color: "red",
    bold: true,
    players: ["Steve"]
};
const VIP: Rank = {
    id: "vip",
    name: "VIP",
    tag: "VIP",
    symbol: "✦",
    color: "gold",
    bold: false,
    players: ["Alex", "Notch_2"]
};

const firstIssue = (input: unknown): string | undefined => {
    const parsed = ranksSchema.safeParse(input);
    return parsed.success ? undefined : (english(parsed.error.issues[0]?.message) ?? undefined);
};

describe("the ranks schema", () => {
    it("normalizes text and player names before checking them", () => {
        const parsed = ranksSchema.parse([
            { ...ADMIN, name: "  Head   Admin ", tag: " ADMIN ", players: [" Steve "] }
        ]);
        expect(parsed[0]).toMatchObject({ name: "Head Admin", tag: "ADMIN", players: ["Steve"] });
    });

    it("refuses what a command line cannot carry", () => {
        expect(firstIssue([{ ...ADMIN, tag: "" }])).toBe("Required");
        expect(firstIssue([{ ...ADMIN, tag: "A".repeat(17) }])).toBe("At most 16 characters");
        expect(firstIssue([{ ...ADMIN, tag: "§cADMIN" }])).toBe(
            "Remove line breaks, spaces and § codes"
        );
        expect(firstIssue([{ ...ADMIN, name: "Ad\u0000min" }])).toBe(
            "Remove line breaks, spaces and § codes"
        );
        expect(firstIssue([{ ...ADMIN, symbol: "⚔ ✦" }])).toBeDefined();
        expect(firstIssue([{ ...ADMIN, color: "#ff0000" }])).toBeDefined();
        expect(firstIssue([{ ...ADMIN, players: ["Steve Two"] }])).toBe("Not a valid player name");
        expect(firstIssue([{ ...ADMIN, players: ["@a"] }])).toBe("Not a valid player name");
        expect(firstIssue([{ ...ADMIN, id: "Admin!" }])).toBeDefined();
    });

    it("accepts a Bedrock player through Floodgate", () => {
        expect(firstIssue([{ ...ADMIN, players: [".Alex"] }])).toBeUndefined();
    });

    it("gives a player one rank, whatever the case", () => {
        expect(firstIssue([ADMIN, { ...VIP, players: ["steve"] }])).toBe(
            "steve already has the rank Admin"
        );
    });

    it("refuses two ranks with one id and more than twenty ranks", () => {
        expect(firstIssue([ADMIN, { ...VIP, id: "admin" }])).toBe("Two ranks share an id");
        const many = Array.from({ length: 21 }, (_, index) => ({
            ...VIP,
            id: `r${index}`,
            players: []
        }));
        expect(firstIssue(many)).toBe("At most 20 ranks");
    });

    it("reads nothing from a config that holds no ranks or broken ones", () => {
        expect(readRanks({}).ranks).toEqual([]);
        expect(readRanks({ ranks: { ranks: [{ id: "x" }] } }).ranks).toEqual([]);
        const state = readRanks({
            ranks: {
                ranks: [ADMIN],
                applied: { teams: ["pr01_admin", "bad name"], players: ["Steve", "@a"] }
            }
        });
        expect(state.ranks).toEqual([ADMIN]);
        expect(state.applied).toEqual({ teams: ["pr01_admin"], players: ["Steve"] });
    });

    it("makes ids from names, unique among the rest", () => {
        expect(rankId("Head Admin!", [])).toBe("head_admin");
        expect(rankId("VIP", ["vip"])).toBe("vip2");
        expect(rankId("✦✦", [])).toBe("rank");
    });
});

describe("the prefix", () => {
    it("is a root with styled children, so the name after it is never bold", () => {
        expect(prefixComponent(ADMIN)).toBe(
            '{"text":"","extra":[{"text":"⚔ ","color":"red"},{"text":"[ADMIN]","color":"red","bold":true},{"text":" "}]}'
        );
        expect(prefixComponent({ ...VIP, symbol: "" })).toBe(
            '{"text":"","extra":[{"text":"[VIP]","color":"gold"},{"text":" "}]}'
        );
    });

    it("escapes a quote and a backslash as JSON does", () => {
        const component = prefixComponent({ ...ADMIN, tag: 'A"B\\C', symbol: "" });
        expect(component).toContain('"text":"[A\\"B\\\\C]"');
        expect(JSON.parse(component).extra[0].text).toBe('[A"B\\C]');
    });
});

describe("the commands an apply sends", () => {
    it("names teams by position, so the tab list sorts by rank", () => {
        expect(teamName(ADMIN, 0)).toBe("pr01_admin");
        expect(teamName(VIP, 9)).toBe("pr10_vip");
        expect(teamName({ id: "abcdefghijk" }, 19)).toHaveLength(16);
    });

    it("creates, styles and fills every team, exactly", () => {
        expect(rankCommands([ADMIN, VIP], { teams: [], players: [] })).toEqual([
            "team add pr01_admin",
            'team modify pr01_admin displayName {"text":"Admin"}',
            'team modify pr01_admin prefix {"text":"","extra":[{"text":"⚔ ","color":"red"},{"text":"[ADMIN]","color":"red","bold":true},{"text":" "}]}',
            "team modify pr01_admin color red",
            "team add pr02_vip",
            'team modify pr02_vip displayName {"text":"VIP"}',
            'team modify pr02_vip prefix {"text":"","extra":[{"text":"✦ ","color":"gold"},{"text":"[VIP]","color":"gold"},{"text":" "}]}',
            "team modify pr02_vip color gold",
            "team join pr01_admin Steve",
            "team join pr02_vip Alex",
            "team join pr02_vip Notch_2"
        ]);
    });

    it("undoes what is no longer wanted, after moving players, and touches no other team", () => {
        const before = appliedBy([ADMIN, VIP]);
        // VIP moved first, Admin lost Steve, a team was adopted from the server.
        const after = [
            { ...VIP, source: "vips" },
            { ...ADMIN, players: [] }
        ];
        const lines = rankCommands(after, before);
        expect(lines.slice(-5)).toEqual([
            "team join pr01_vip Notch_2",
            "team leave Steve",
            "team remove pr01_admin",
            "team remove pr02_vip",
            "team remove vips"
        ]);
        expect(lines.filter((line) => line.startsWith("team remove"))).toHaveLength(3);
        expect(replacedTeams(after)).toEqual(["vips"]);
    });

    it("is the same list when nothing changed, so sending it twice is harmless", () => {
        const applied = appliedBy([ADMIN, VIP]);
        const lines = rankCommands([ADMIN, VIP], applied);
        expect(
            lines.some((line) => line.startsWith("team remove") || line.startsWith("team leave"))
        ).toBe(false);
        expect(rankCommands([ADMIN, VIP], applied)).toEqual(lines);
    });

    it("has no line with a line break in it", () => {
        for (const line of rankCommands([ADMIN, VIP], {
            teams: ["pr03_old"],
            players: ["Herobrine"]
        }))
            expect(line).not.toMatch(/[\r\n\0]/);
    });

    it("joins only ranked players who arrived", () => {
        expect(joinCommands([ADMIN, VIP], ["steve", "Alex", "Herobrine", "bad name"])).toEqual([
            "team join pr01_admin steve",
            "team join pr02_vip Alex"
        ]);
    });
});

// ---------------------------------------------------------------- import

/** A tiny NBT writer, for files shaped like the game's. */
type Tag =
    | ["byte", number]
    | ["string", string]
    | ["list-string", string[]]
    | ["list-compound", Record<string, Tag>[]]
    | ["compound", Record<string, Tag>];
function str(value: string): Buffer {
    const bytes = Buffer.from(value, "utf8");
    const head = Buffer.alloc(2);
    head.writeUInt16BE(bytes.length);
    return Buffer.concat([head, bytes]);
}
function typeOf(tag: Tag): number {
    return { byte: 1, string: 8, "list-string": 9, "list-compound": 9, compound: 10 }[tag[0]];
}
function payload(tag: Tag): Buffer {
    switch (tag[0]) {
        case "byte":
            return Buffer.from([tag[1]]);
        case "string":
            return str(tag[1]);
        case "list-string": {
            const head = Buffer.alloc(5);
            head.writeInt8(8, 0);
            head.writeInt32BE(tag[1].length, 1);
            return Buffer.concat([head, ...tag[1].map(str)]);
        }
        case "list-compound": {
            const head = Buffer.alloc(5);
            head.writeInt8(10, 0);
            head.writeInt32BE(tag[1].length, 1);
            return Buffer.concat([head, ...tag[1].map((one) => payload(["compound", one]))]);
        }
        case "compound":
            return Buffer.concat([
                ...Object.entries(tag[1]).map(([key, inner]) =>
                    Buffer.concat([Buffer.from([typeOf(inner)]), str(key), payload(inner)])
                ),
                Buffer.from([0])
            ]);
    }
}
function scoreboard(teams: Record<string, Tag>[]): Buffer {
    const root = payload(["compound", { data: ["compound", { Teams: ["list-compound", teams] }] }]);
    return gzipSync(Buffer.concat([Buffer.from([10]), str(""), root]));
}

describe("importing the server's teams", () => {
    it("reads a 1.20 scoreboard, where components are JSON strings", () => {
        const file = scoreboard([
            {
                Name: ["string", "admins"],
                DisplayName: ["string", '{"text":"Admins"}'],
                MemberNamePrefix: [
                    "string",
                    '[{"text":"⚔ ","color":"red"},{"text":"[ADMIN]","color":"red","bold":true},{"text":" "}]'
                ],
                TeamColor: ["string", "red"],
                Players: ["list-string", ["Steve"]]
            },
            {
                Name: ["string", "mods"],
                DisplayName: ["string", '"Mods"'],
                MemberNamePrefix: ["string", '"§9◆ [MOD] "'],
                Players: ["list-string", ["Alex", "@bad"]]
            }
        ]);
        const teams = teamsFromScoreboard(readNbt(file));
        expect(teams.map((team) => team.name)).toEqual(["admins", "mods"]);
        expect(ranksFromTeams(teams, [])).toEqual([
            {
                id: "admins",
                name: "Admins",
                tag: "ADMIN",
                symbol: "⚔",
                color: "red",
                bold: true,
                players: ["Steve"],
                source: "admins"
            },
            {
                id: "mods",
                name: "Mods",
                tag: "MOD",
                symbol: "◆",
                color: "blue",
                bold: false,
                players: ["Alex"],
                source: "mods"
            }
        ]);
    });

    it("reads a 1.21.5 scoreboard, where components are compounds", () => {
        const file = scoreboard([
            {
                Name: ["string", "vip"],
                DisplayName: ["compound", { text: ["string", "VIP"] }],
                MemberNamePrefix: [
                    "compound",
                    {
                        text: ["string", ""],
                        extra: [
                            "list-compound",
                            [
                                { text: ["string", "✦ "], color: ["string", "gold"] },
                                {
                                    text: ["string", "[VIP]"],
                                    color: ["string", "gold"],
                                    bold: ["byte", 1]
                                }
                            ]
                        ]
                    }
                ],
                TeamColor: ["string", "gold"],
                Players: ["list-string", ["Alex"]]
            }
        ]);
        const [rank] = ranksFromTeams(teamsFromScoreboard(readNbt(file)), []);
        expect(rank).toMatchObject({
            name: "VIP",
            tag: "VIP",
            symbol: "✦",
            color: "gold",
            bold: true,
            players: ["Alex"],
            source: "vip"
        });
    });

    it("skips Polaris's own teams and teams already adopted, and keeps ids unique", () => {
        const teams = [
            {
                name: "pr01_admin",
                displayName: "Admin",
                prefix: "[ADMIN] ",
                color: "red",
                players: []
            },
            { name: "vips", displayName: "VIP", prefix: "[VIP] ", color: null, players: [] },
            { name: "admins", displayName: "Admin", prefix: "", color: "dark_red", players: [] }
        ];
        const found = ranksFromTeams(teams, [ADMIN]);
        expect(found.map((rank) => [rank.id, rank.tag, rank.color])).toEqual([
            ["vip", "VIP", "white"],
            ["admin2", "Admin", "dark_red"]
        ]);
        expect(
            ranksFromTeams(teams, [{ ...VIP, source: "vips" }]).map((rank) => rank.source)
        ).toEqual(["admins"]);
    });

    it("refuses a file that is not NBT or that ends early", () => {
        expect(() => readNbt(Buffer.from("not nbt"))).toThrow();
        const whole = scoreboard([{ Name: ["string", "x"] }]);
        expect(() => readNbt(gzipSync(Buffer.from([10, 0, 0, 10, 0])))).toThrow();
        expect(teamsFromScoreboard(readNbt(whole))).toHaveLength(1);
    });
});
