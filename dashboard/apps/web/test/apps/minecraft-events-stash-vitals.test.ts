/**
 * Health and hunger through an arena or a stage: a player leaves with what they
 * came in with - after a fight, after a death in it, and after logging off
 * before the end - through the effects and the damage the game itself applies,
 * simulated here as vanilla 1.21 does them.
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

const { stashIn, giveBack, vitalsSettled } = await import(
    "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stash-service"
);
type Stash = Parameters<typeof giveBack>[2];

const f = Math.fround;

/** Ana as the game keeps her: floats where the game keeps floats. */
let ana = { health: 20, absorption: 0, food: 20, saturation: 5, exhaustion: 0 };
let online = true;
/** Resistance V on her, as the trip home leaves it: only damage past it lands. */
let resisting = true;
let hunger: { seconds: number; amplifier: number } | null = null;
let said: string[] = [];

/** Hunger running its course, a tick at a time, as `FoodData.tick` drains it. */
function runHunger(): void {
    if (!hunger) return;
    for (let tick = 0; tick < hunger.seconds * 20; tick += 1) {
        ana.exhaustion = f(Math.min(ana.exhaustion + f(0.005 * (hunger.amplifier + 1)), 40));
        if (ana.exhaustion > 4) {
            ana.exhaustion = f(ana.exhaustion - 4);
            if (ana.saturation > 0) ana.saturation = f(Math.max(ana.saturation - 1, 0));
            else ana.food = Math.max(ana.food - 1, 0);
        }
    }
    hunger = null;
}

const data = (value: string) => `Ana has the following entity data: ${value}`;

async function say(argv: readonly string[]): Promise<string> {
    const line = argv.join(" ");
    said.push(line);
    if (!online) return "No entity was found";
    if (line === "data get entity Ana Inventory") return data("[]");
    if (line === "xp query Ana levels") return "Ana has 0 experience levels";
    if (line === "xp query Ana points") return "Ana has 0 experience points";
    if (line === "data get entity Ana Health") return data(`${ana.health}f`);
    if (line === "data get entity Ana foodLevel") return data(`${ana.food}`);
    if (line === "data get entity Ana foodSaturationLevel") return data(`${ana.saturation}f`);
    if (line === "data get entity Ana foodExhaustionLevel") return data(`${ana.exhaustion}f`);
    if (line === "data get entity Ana AbsorptionAmount") return data(`${ana.absorption}f`);
    if (/^effect give Ana minecraft:instant_health 1 \d+ true$/.test(line)) {
        ana.health = 20;
        return "Applied effect";
    }
    const damage = /^damage Ana (\S+) (\S+)$/.exec(line);
    if (damage) {
        // Only damage that passes Resistance lands while she has it.
        if (resisting && damage[2] !== "minecraft:generic_kill") return "Applied damage";
        let amount = f(Number(damage[1]));
        const soaked = Math.min(amount, ana.absorption);
        ana.absorption = f(ana.absorption - soaked);
        amount = f(amount - soaked);
        ana.health = f(Math.max(ana.health - amount, 0));
        return "Applied damage";
    }
    const feed = /^effect give Ana minecraft:saturation 1 (\d+) true$/.exec(line);
    if (feed) {
        const points = Number(feed[1]) + 1;
        ana.food = Math.min(Math.max(points + ana.food, 0), 20);
        ana.saturation = f(Math.min(Math.max(points * 2 + ana.saturation, 0), ana.food));
        return "Applied effect";
    }
    const starve = /^effect give Ana minecraft:hunger (\d+) (\d+) true$/.exec(line);
    if (starve) {
        hunger = { seconds: Number(starve[1]), amplifier: Number(starve[2]) };
        return "Applied effect";
    }
    return "";
}

const server = {
    installedAppId: "app",
    say,
    sayAll: async (lines: readonly string[]) => {
        for (const line of lines) await say([line]);
    }
} as never;

/** Waiting: the game's ticks pass meanwhile. */
const wait = async () => runHunger();

const owner = { installedAppId: "app", runId: "run", event: "Duel" };

async function cameIn(): Promise<Stash> {
    let kept: Stash | null = null;
    const result = await stashIn(server, owner, "Ana", async (each) => {
        kept = each;
    });
    expect(result.refused).toBeNull();
    expect(kept).not.toBeNull();
    return kept!;
}

/** Back as they came: exhaustion to a tenth and a half wherever Hunger ran -
 *  and, where it did not have to, left as the event left it, since nothing in
 *  the game lowers it. */
async function expectBack(
    wanted: { health: number; food: number; saturation: number; exhaustion: number },
    ended: { exhaustion: number }
) {
    await vitalsSettled("app", "Ana");
    expect(ana.health).toBeCloseTo(wanted.health, 2);
    expect(ana.absorption).toBe(0);
    expect(ana.food).toBe(wanted.food);
    expect(ana.saturation).toBeGreaterThanOrEqual(wanted.saturation - 0.01);
    expect(ana.saturation).toBeLessThan(wanted.saturation + 1);
    expect(ana.exhaustion).toBeGreaterThanOrEqual(wanted.exhaustion - 0.15);
    if (said.some((line) => line.includes("minecraft:hunger ")))
        expect(ana.exhaustion).toBeLessThan(Math.max(wanted.exhaustion, 0.1) + 0.06);
    else expect(ana.exhaustion).toBeCloseTo(Math.max(ended.exhaustion, wanted.exhaustion), 4);
}

beforeEach(() => {
    rows.clear();
    online = true;
    resisting = true;
    hunger = null;
    said = [];
});

describe("health and hunger through an event", () => {
    it("puts back what a fight took, and takes back what the arena fed", async () => {
        const joined = { health: 13.5, food: 14, saturation: 2.4, exhaustion: 1.7 };
        ana = { ...joined, absorption: 0 };
        const kept = await cameIn();
        expect(kept.vitals).toEqual(joined);
        expect(rows.get(kept.record!)).toMatchObject({ health: 13.5, foodLevel: 14 });

        // Hurt in the fight, fed to the full inside, and a golden apple's
        // absorption on top.
        ana = { health: 4, absorption: 4, food: 20, saturation: 20, exhaustion: 0.3 };
        const ended = { ...ana };
        expect(await giveBack(server, "Ana", kept, async () => undefined, wait)).toBe("done");
        await expectBack(joined, ended);
        expect(rows.size).toBe(0);
    });

    it("gives back hunger and health to somebody who died in it and came back full", async () => {
        const joined = { health: 7, food: 9, saturation: 0, exhaustion: 3.2 };
        ana = { ...joined, absorption: 0 };
        const kept = await cameIn();
        // Respawned: what the game gives everybody new.
        ana = { health: 20, absorption: 0, food: 20, saturation: 5, exhaustion: 0 };
        const ended = { ...ana };
        expect(await giveBack(server, "Ana", kept, async () => undefined, wait)).toBe("done");
        await expectBack(joined, ended);
    });

    it("fills up somebody who came in fuller than the event left them", async () => {
        const joined = { health: 20, food: 20, saturation: 12.5, exhaustion: 0 };
        ana = { ...joined, absorption: 0 };
        const kept = await cameIn();
        ana = { health: 1, absorption: 0, food: 3, saturation: 0, exhaustion: 2 };
        const ended = { ...ana };
        expect(await giveBack(server, "Ana", kept, async () => undefined, wait)).toBe("done");
        await expectBack(joined, ended);
    });

    it("keeps them for a player who logged off, and gives them back on their return", async () => {
        const joined = { health: 11, food: 16, saturation: 3, exhaustion: 0.5 };
        ana = { ...joined, absorption: 0 };
        const kept = await cameIn();
        ana = { health: 2, absorption: 0, food: 6, saturation: 0, exhaustion: 0 };
        const ended = { ...ana };
        online = false;
        let left: Stash | null = kept;
        expect(await giveBack(server, "Ana", kept, async (each) => void (left = each), wait)).toBe(
            "offline"
        );
        expect(left).toBe(kept);
        // Back on, with the run's copy lost to a restart: the database row has them.
        online = true;
        expect(
            await giveBack(server, "Ana", { ...kept, vitals: null }, async () => undefined, wait)
        ).toBe("done");
        await expectBack(joined, ended);
    });

    it("leaves health and hunger alone for a stash kept before they were", async () => {
        ana = { health: 6, absorption: 0, food: 20, saturation: 3, exhaustion: 0 };
        const kept = await cameIn();
        const row = rows.get(kept.record!)!;
        rows.set(kept.record!, {
            ...row,
            health: null,
            foodLevel: null,
            foodSaturation: null,
            foodExhaustion: null
        });
        said = [];
        expect(
            await giveBack(server, "Ana", { ...kept, vitals: null }, async () => undefined, wait)
        ).toBe("done");
        await vitalsSettled("app", "Ana");
        expect(said.some((line) => /^(effect|damage) /.test(line))).toBe(false);
        expect(ana.health).toBe(6);
    });

    it("gives back without waiting for their food to drain", async () => {
        const joined = { health: 12, food: 10, saturation: 0, exhaustion: 0.5 };
        ana = { ...joined, absorption: 0 };
        const kept = await cameIn();
        ana = { health: 20, absorption: 0, food: 20, saturation: 20, exhaustion: 0 };
        const ended = { ...ana };
        let release: () => void = () => undefined;
        const held = () =>
            new Promise<void>((resolve) => {
                release = () => {
                    runHunger();
                    resolve();
                };
            });
        expect(await giveBack(server, "Ana", kept, async () => undefined, held)).toBe("done");
        expect(rows.size).toBe(0);
        expect(said.some((line) => line.includes("minecraft:hunger "))).toBe(true);
        expect(ana.food).toBe(20);
        let settled = false;
        void vitalsSettled("app", "Ana").then(() => (settled = true));
        while (!settled) {
            release();
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        await expectBack(joined, ended);
    });

    it("touches nothing when they leave as they came", async () => {
        ana = { health: 15, absorption: 0, food: 18, saturation: 1, exhaustion: 0.4 };
        const kept = await cameIn();
        said = [];
        expect(await giveBack(server, "Ana", kept, async () => undefined, wait)).toBe("done");
        await vitalsSettled("app", "Ana");
        expect(said.some((line) => /^(effect|damage) /.test(line))).toBe(false);
    });

    it("comes as close as the game allows from any start to any end, every time", async () => {
        // A fixed sequence, so a failure reproduces.
        let seed = 7;
        const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
        const vitals = () => {
            const food = Math.floor(random() * 21);
            return {
                health: f(0.5 + Math.round(random() * 39) / 2),
                food,
                saturation: f(Math.round(random() * food * 10) / 10),
                exhaustion: f(Math.round(random() * 39) / 10)
            };
        };
        for (let run = 0; run < 300; run += 1) {
            rows.clear();
            const joined = vitals();
            ana = { ...joined, absorption: 0 };
            const kept = await cameIn();
            ana = { ...vitals(), absorption: random() < 0.3 ? 4 : 0 };
            const ended = { ...ana };
            said = [];
            expect(await giveBack(server, "Ana", kept, async () => undefined, wait)).toBe("done");
            await expectBack(joined, ended);
        }
    });
});
