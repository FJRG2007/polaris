/**
 * What the Anti-cheat tab lists under each player, and what it costs to read.
 *
 * The totals come from a count per player and check; the rows under a player
 * are only the newest few. Reading every flag on the server to throw most of
 * them away is what this pins against: each player's rows are asked for bounded
 * to what is shown, and a player with hundreds of alerts still reports all of
 * them in the totals.
 */

import { describe, expect, it, vi } from "vitest";

const SERVER = "01a0a00b-35c5-7932-861e-1b2161a9b298";
const NOW = Date.now();

interface Flag {
    installedAppId: string;
    player: string;
    playerName: string;
    check: string;
    violations: number;
    verbose: string;
    at: Date;
}

/** A player with far more alerts than the tab lists, and one with a couple. */
const flags: Flag[] = [
    ...Array.from({ length: 150 }, (_, index) => ({
        installedAppId: SERVER,
        player: "busy",
        playerName: "Busy",
        check: index % 2 === 0 ? "Reach" : "Fly",
        violations: index,
        verbose: `line ${index}`,
        at: new Date(NOW - index * 1000)
    })),
    ...Array.from({ length: 2 }, (_, index) => ({
        installedAppId: SERVER,
        player: "quiet",
        playerName: "Quiet",
        check: "Reach",
        violations: 1,
        verbose: `quiet ${index}`,
        at: new Date(NOW - index * 1000)
    }))
];

/** Every row handed out by a row query, which is what the read costs. */
let rowsRead = 0;

vi.mock("@polaris/db", () => ({
    prisma: {
        minecraftAnticheatFlag: {
            groupBy: async () => {
                const groups = new Map<string, { player: string; check: string; flags: Flag[] }>();
                for (const flag of flags) {
                    const key = `${flag.player}|${flag.check}`;
                    const held = groups.get(key) ?? { player: flag.player, check: flag.check, flags: [] };
                    held.flags.push(flag);
                    groups.set(key, held);
                }
                return [...groups.values()].map((group) => ({
                    player: group.player,
                    check: group.check,
                    _count: { _all: group.flags.length },
                    _max: {
                        violations: Math.max(...group.flags.map((flag) => flag.violations)),
                        at: new Date(Math.max(...group.flags.map((flag) => flag.at.getTime()))),
                        playerName: group.flags[0]!.playerName
                    }
                }));
            },
            findMany: async ({ where, take }: { where: { player?: string }; take?: number }) => {
                const matching = flags
                    .filter((flag) => where.player === undefined || flag.player === where.player)
                    .sort((left, right) => right.at.getTime() - left.at.getTime())
                    .slice(0, take ?? Infinity);
                rowsRead += matching.length;
                return matching;
            }
        }
    }
}));

const { engineRecords } = await import(
    "@polaris-app/game-servers/src/lib/minecraft/polaris-anticheat-service"
);

describe("engineRecords", () => {
    it("totals every alert and lists only the newest twenty per player", async () => {
        const records = await engineRecords(SERVER);
        const busy = records.find((record) => record.name === "Busy")!;
        const quiet = records.find((record) => record.name === "Quiet")!;

        expect(busy.checks.reduce((sum, check) => sum + check.alerts, 0)).toBe(150);
        expect(busy.recent).toHaveLength(20);
        expect(busy.recent[0]!.verbose).toBe("line 0");
        expect(quiet.recent.map((row) => row.verbose)).toEqual(["quiet 0", "quiet 1"]);
        // Twenty for the one and two for the other: nothing read to be dropped.
        expect(rowsRead).toBe(22);
    });
});
