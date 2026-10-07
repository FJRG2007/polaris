/**
 * How fast an event goes from step to step (`kinds/pace`): what several players
 * need is asked in shared trips, so the trips a step costs do not grow with how
 * many play; block work is cut into trips no heavier than the pacer allows, and
 * lighter ones when the server is slow to answer them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = new Map<string, Record<string, unknown>>();

vi.mock("@polaris/db", () => ({
    prisma: {
        eventInventoryStash: {
            create: async ({ data }: { data: Record<string, unknown> }) => {
                const id = `row${rows.size + 1}`;
                rows.set(id, { ...data, id });
                return { id };
            },
            update: async ({
                where,
                data
            }: {
                where: { id: string };
                data: Record<string, unknown>;
            }) => {
                rows.set(where.id, { ...rows.get(where.id), ...data });
                return rows.get(where.id);
            },
            findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
            deleteMany: async ({ where }: { where: { id: string } }) => {
                rows.delete(where.id);
                return { count: 1 };
            }
        }
    }
}));

vi.mock("@polaris/app-host", () => ({
    host: {
        appsInstallConfig: {
            readInstallConfig: () => ({}),
            patchInstallConfig: async () => undefined
        }
    }
}));

vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    withServerContainer: async () => {
        throw new Error("not in this test");
    }
}));

const pace = await import("@polaris-app/game-servers/src/lib/minecraft/events/kinds/pace");
const { stashIn, giveBack, vitalsSettled } = await import(
    "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stash-service"
);
type Stash = Parameters<typeof giveBack>[2];

interface Player {
    health: number;
    food: number;
    saturation: number;
    bread: number;
}

/** Players as the game keeps them, by name. */
let players = new Map<string, Player>();
/** Every trip into the server, as the lines it carried. */
let trips: string[][] = [];

const data = (name: string, value: string) => `${name} has the following entity data: ${value}`;

function answer(line: string): string {
    const read = /^data get entity (\w+) (\w+)$/.exec(line);
    if (read) {
        const one = players.get(read[1]!);
        if (!one) return "No entity was found";
        switch (read[2]) {
            case "Inventory":
                return data(
                    read[1]!,
                    one.bread > 0
                        ? `[{Slot: 0b, id: "minecraft:bread", count: ${one.bread}}]`
                        : "[]"
                );
            case "Health":
                return data(read[1]!, `${one.health}f`);
            case "foodLevel":
                return data(read[1]!, `${one.food}`);
            case "foodSaturationLevel":
                return data(read[1]!, `${one.saturation}f`);
            case "foodExhaustionLevel":
            case "AbsorptionAmount":
                return data(read[1]!, "0.0f");
            default:
                return "";
        }
    }
    const xp = /^xp query (\w+) (levels|points)$/.exec(line);
    if (xp) return `${xp[1]} has 0 experience ${xp[2]}`;
    const empty = /^item replace entity (\w+) hotbar\.0 with minecraft:air$/.exec(line);
    if (empty) players.get(empty[1]!)!.bread = 0;
    const heal = /^effect give (\w+) minecraft:instant_health /.exec(line);
    if (heal) players.get(heal[1]!)!.health = 20;
    const feed = /^effect give (\w+) minecraft:saturation 1 (\d+) true$/.exec(line);
    if (feed) {
        const one = players.get(feed[1]!)!;
        const points = Number(feed[2]) + 1;
        one.food = Math.min(one.food + points, 20);
        one.saturation = Math.min(one.saturation + points * 2, one.food);
    }
    const hurt = /^damage (\w+) (\S+) minecraft:generic_kill$/.exec(line);
    if (hurt) players.get(hurt[1]!)!.health -= Number(hurt[2]);
    return "";
}

const server = {
    installedAppId: "app",
    edition: "java",
    say: async (argv: readonly string[]) => {
        trips.push([argv.join(" ")]);
        return answer(argv.join(" "));
    },
    sayAll: async (lines: readonly string[]) => {
        trips.push([...lines]);
        for (const line of lines) answer(line);
    },
    sayEach: async (argvs: readonly (readonly string[])[]) => {
        trips.push(argvs.map((argv) => argv.join(" ")));
        return argvs.map((argv) => answer(argv.join(" ")));
    }
} as never;

const owner = { installedAppId: "app", runId: "run", event: "Duel" };
const named = (count: number) => Array.from({ length: count }, (_, index) => `P${index + 1}`);

beforeEach(() => {
    rows.clear();
    players = new Map();
    trips = [];
});

/** Everybody's things put away side by side, as an arena does it. */
async function stashEverybody(names: readonly string[]): Promise<Map<string, Stash>> {
    const shared = pace.coalescing(server);
    const kept = new Map<string, Stash>();
    await Promise.all(
        names.map(async (name) => {
            const result = await stashIn(shared, owner, name, async (each) => {
                kept.set(name, each);
            });
            expect(result.refused).toBeNull();
        })
    );
    return kept;
}

describe("what several players need, in shared trips", () => {
    it("puts everybody's things away in as many trips for twelve players as for one", async () => {
        const counted = async (count: number) => {
            players = new Map(
                named(count).map((name) => [
                    name,
                    { health: 20, food: 20, saturation: 5, bread: 3 }
                ])
            );
            trips = [];
            await stashEverybody(named(count));
            for (const one of players.values()) expect(one.bread).toBe(0);
            return trips.length;
        };
        const one = await counted(1);
        expect(await counted(12)).toBe(one);
    });

    it("gives health and hunger back to everybody in as many trips for twelve as for one", async () => {
        const counted = async (count: number) => {
            players = new Map(
                named(count).map((name) => [
                    name,
                    { health: 20, food: 20, saturation: 5, bread: 0 }
                ])
            );
            const kept = await stashEverybody(named(count));
            // Hurt in the fight.
            for (const one of players.values()) one.health = 6;
            trips = [];
            const shared = pace.coalescing(server);
            await Promise.all(
                named(count).map((name) =>
                    giveBack(
                        shared,
                        name,
                        kept.get(name)!,
                        async () => undefined,
                        async () => undefined
                    )
                )
            );
            for (const name of named(count)) await vitalsSettled("app", name);
            for (const one of players.values()) {
                expect(one.health).toBeCloseTo(20, 2);
                expect(one.food).toBe(20);
            }
            return trips.length;
        };
        const one = await counted(1);
        expect(await counted(12)).toBe(one);
    });

    it("costs one player's trips for everybody, where one at a time cost each of them", async () => {
        const counted = async (count: number, together: boolean) => {
            players = new Map(
                named(count).map((name) => [
                    name,
                    { health: 20, food: 20, saturation: 5, bread: 2 }
                ])
            );
            trips = [];
            for (const name of together ? [] : named(count))
                await stashIn(server, owner, name, async () => undefined);
            if (together) await stashEverybody(named(count));
            return trips.length;
        };
        const alone = await counted(12, false);
        const together = await counted(12, true);
        // 84 trips one at a time; 4 side by side.
        expect(together * 6).toBeLessThan(alone);
    });

    it("asks a read alone that is not a plain read of one player", async () => {
        const shared = pace.coalescing(server);
        players.set("Ana", { health: 20, food: 20, saturation: 5, bread: 0 });
        await Promise.all([
            shared.say(["xp query Ana levels"]),
            shared.say(["xp query Ana points"]),
            shared.say(["execute as @a run data get entity @s Pos"])
        ]);
        expect(trips).toEqual([
            ["execute as @a run data get entity @s Pos"],
            ["xp query Ana levels", "xp query Ana points"]
        ]);
    });

    it("asks again together what missed a trip's cut, then alone", async () => {
        let cut = true;
        const cutting = {
            ...(server as object),
            sayEach: async (argvs: readonly (readonly string[])[]) => {
                trips.push(argvs.map((argv) => argv.join(" ")));
                // The first answer only: the rest past the 16 KiB a trip hands back.
                const answers = argvs.map((argv, at) =>
                    !cut || at === 0 ? answer(argv.join(" ")) : null
                );
                cut = false;
                return answers;
            }
        } as never;
        players.set("Ana", { health: 7, food: 20, saturation: 5, bread: 0 });
        const shared = pace.coalescing(cutting);
        const said = await Promise.all(
            ["Health", "foodLevel", "AbsorptionAmount"].map((field) =>
                shared.say([`data get entity Ana ${field}`])
            )
        );
        expect(said[0]).toContain("7f");
        expect(said[1]).toContain(": 20");
        expect(trips).toEqual([
            [
                "data get entity Ana Health",
                "data get entity Ana foodLevel",
                "data get entity Ana AbsorptionAmount"
            ],
            ["data get entity Ana foodLevel", "data get entity Ana AbsorptionAmount"]
        ]);
    });

    it("answers every read of a start from one trip, and a second read live", async () => {
        const reads = ["gamerule keepInventory", "gamerule doDaylightCycle"];
        const prefetched = pace.prefetching(server, reads);
        await prefetched.say(["gamerule keepInventory"]);
        await prefetched.say(["gamerule doDaylightCycle"]);
        await prefetched.say(["gamerule keepInventory"]);
        expect(trips).toEqual([reads, ["gamerule keepInventory"]]);
    });
});

describe("block work, paced", () => {
    const fill = (size: number) =>
        `execute in minecraft:overworld run fill 0 0 0 ${size - 1} 0 0 minecraft:stone keep`;

    it("never puts more than a fill's worth in one trip to start with", () => {
        const pacing = pace.buildPacer();
        const lines = [fill(20_000), fill(20_000), fill(100), fill(100)];
        expect(pacing.take(lines, pace.fillVolume)).toEqual([lines[0]]);
        expect(pacing.take(lines.slice(1), pace.fillVolume)).toEqual(lines.slice(1));
        expect(pace.fillVolume(fill(32_768))).toBe(32_768);
    });

    it("sends a smaller trip after one the server was slow to answer", async () => {
        vi.useFakeTimers({ now: 0 });
        try {
            const pacing = pace.buildPacer();
            const sizes: number[] = [];
            const lines = Array.from({ length: 80 }, () => fill(4_096));
            const took = [10, 10, 400, 10];
            let trip = 0;
            await pace.inTrips(lines, pacing, async (sent) => {
                sizes.push(sent.length);
                vi.setSystemTime(Date.now() + (took[trip++] ?? 10));
            });
            // 8 to start (32,768 blocks); 16 after quick trips; halved after the slow one.
            expect(sizes.slice(0, 4)).toEqual([8, 16, 16, 8]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("tells whether every chunk under a box is in, in one trip", async () => {
        const loaded = (unloaded: boolean) =>
            ({
                ...(server as object),
                sayEach: async (argvs: readonly (readonly string[])[]) => {
                    trips.push(argvs.map((argv) => argv.join(" ")));
                    return argvs.map((_, at) =>
                        unloaded && at === 1
                            ? "That position is not loaded"
                            : "No blocks were filled"
                    );
                }
            }) as never;
        const box = { x1: 0, y1: 64, z1: 0, x2: 20, z2: 5 };
        expect(await pace.allLoaded(loaded(false), box)).toBe(true);
        expect(await pace.allLoaded(loaded(true), box)).toBe(false);
        expect(trips).toHaveLength(2);
        expect(trips[0]).toHaveLength(2);
    });
});
