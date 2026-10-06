/**
 * Challenges run end to end against a simulated server that answers exactly as
 * a vanilla one does over RCON: replies glued together with no line breaks,
 * nothing at all from an `execute` over nobody, objectives shown by their
 * display name in brackets, a statistic the version lacks refused - and
 * statistics that only count while their player is on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ------------------------------------------------------------------ the simulated server

interface Player {
    name: string;
    x: number;
    y: number;
    z: number;
    yaw: number;
    online: boolean;
}

class FakeServer {
    objectives = new Map<string, string>();
    scores = new Map<string, Map<string, number>>();
    players = new Map<string, Player>();
    unknown = new Set<string>();
    heard: string[] = [];
    /** How `scoreboard players get` prints a player from 1.20.3: a team's prefix and suffix around the name. */
    displays = new Map<string, string>();

    join(name: string, x = 0, z = 0): Player {
        const player = this.players.get(name) ?? { name, x, y: 64, z, yaw: 0, online: true };
        player.online = true;
        this.players.set(name, player);
        return player;
    }

    /** A statistic going up, as the game does it: only for somebody online. */
    add(name: string, criterion: string, by: number): void {
        if (!this.players.get(name)?.online) return;
        for (const [objective, counted] of this.objectives) {
            if (counted !== criterion) continue;
            this.set(name, objective, (this.scores.get(name)?.get(objective) ?? 0) + by);
        }
    }

    move(name: string, dx: number, yaw = 0): void {
        const player = this.players.get(name)!;
        player.x += dx;
        player.yaw += yaw;
    }

    set(name: string, objective: string, value: number): void {
        const held = this.scores.get(name) ?? new Map<string, number>();
        held.set(objective, value);
        this.scores.set(name, held);
    }

    get online(): Player[] {
        return [...this.players.values()].filter((one) => one.online);
    }

    answer(command: string): string {
        this.heard.push(command);
        let match: RegExpExecArray | null;
        if ((match = /^scoreboard objectives add (\S+) (\S+)$/.exec(command))) {
            const [, name, criterion] = match as unknown as [string, string, string];
            if (this.unknown.has(criterion)) return `Unknown criterion '${criterion}'`;
            if (this.objectives.has(name)) return "An objective already exists by that name";
            this.objectives.set(name, criterion);
            return `Created new objective [${name}]`;
        }
        if ((match = /^scoreboard objectives remove (\S+)$/.exec(command))) {
            const name = match[1]!;
            if (!this.objectives.delete(name)) return `Unknown scoreboard objective '${name}'`;
            for (const held of this.scores.values()) held.delete(name);
            return `Removed objective [${name}]`;
        }
        if (command === "scoreboard objectives list") {
            const names = [...this.objectives.keys()];
            return names.length === 0
                ? "There are no objectives"
                : `There are ${names.length} objective(s): ${names.map((one) => `[${one}]`).join(", ")}`;
        }
        if ((match = /^scoreboard players list (\S+)$/.exec(command))) {
            const held = [...(this.scores.get(match[1]!) ?? new Map()).entries()];
            if (held.length === 0) return `${match[1]} has no scores to show`;
            return `${match[1]} has ${held.length} score(s):${held.map(([objective, value]) => `[${objective}]: ${value}`).join("")}`;
        }
        if (
            (match =
                /^execute as @a\[scores=\{(\S+)=1\.\.\}\] run scoreboard players get @s \S+$/.exec(
                    command
                ))
        ) {
            const objective = match[1]!;
            return this.online
                .filter((one) => (this.scores.get(one.name)?.get(objective) ?? 0) >= 1)
                .map(
                    (one) =>
                        `${this.displays.get(one.name) ?? one.name} has ${this.scores.get(one.name)!.get(objective)} [${objective}]`
                )
                .join("");
        }
        if ((match = /^execute as @a run scoreboard players get @s (\S+)$/.exec(command))) {
            const objective = match[1]!;
            return this.online
                .filter((one) => this.scores.get(one.name)?.has(objective))
                .map(
                    (one) =>
                        `${one.name} has ${this.scores.get(one.name)!.get(objective)} [${objective}]`
                )
                .join("");
        }
        if ((match = /^scoreboard players set (\S+) (\S+) (-?\d+)$/.exec(command))) {
            this.set(match[1]!, match[2]!, Number(match[3]));
            return `Set [${match[2]}] for ${match[1]} to ${match[3]}`;
        }
        if (command.startsWith("scoreboard players enable")) return "";
        if (command === "list uuids")
            return `There are ${this.online.length} of a max of 20 players online: ${this.online.map((one) => `${one.name} (00000000-0000-0000-0000-000000000000)`).join(", ")}`;
        if (command === "execute as @a run data get entity @s Pos")
            return this.online
                .map(
                    (one) =>
                        `${one.name} has the following entity data: [${one.x}.5d, ${one.y}.0d, ${one.z}.5d]`
                )
                .join("");
        if (command === "execute as @a run data get entity @s Rotation")
            return this.online
                .map((one) => `${one.name} has the following entity data: [${one.yaw}.0f, 0.0f]`)
                .join("");
        if (command === "execute as @a run data get entity @s Dimension")
            return this.online
                .map((one) => `${one.name} has the following entity data: "minecraft:overworld"`)
                .join("");
        if ((match = /^give (\S+) (\S+) (\d+)$/.exec(command)))
            return `Gave ${match[3]} [${match[2]}] to ${match[1]}`;
        if ((match = /^xp add (\S+) (\d+) levels$/.exec(command)))
            return `Gave ${match[2]} experience levels to ${match[1]}`;
        if ((match = /^clear (\S+) \S+ 0$/.exec(command)))
            return `No items were found on player ${match[1]}`;
        if (command.startsWith("execute if entity")) return "Test failed";
        return "";
    }
}

let fake = new FakeServer();
const server = {
    installedAppId: "srv",
    applicationId: "app",
    edition: "java" as const,
    running: true,
    run: async (argv: readonly string[]) => {
        const line = argv.join(" ");
        if (line.includes("Starting minecraft server version"))
            return { code: 0, output: "Starting minecraft server version 1.21.4\n" };
        if (line.startsWith("stat")) return { code: 0, output: "0\n" };
        if (line.includes("server.properties")) return { code: 0, output: "level-name=world\n" };
        return { code: 1, output: "No such file or directory" };
    },
    runOk: async () => "",
    say: async (argv: readonly string[]) => `${fake.answer(argv.join(" "))}\u001b[0m\n`,
    sayAll: async (lines: readonly string[]) => {
        for (const line of lines) fake.answer(line);
    },
    readFile: async () => new ReadableStream(),
    trimWorld: null
};

// ------------------------------------------------------------------ the database

let config: Record<string, unknown> = {};
const players = new Map<string, { player: string; playerName: string; data: string }>();
const ledgers = new Map<string, { scope: string; holder: string; data: string }>();
const links = new Map<string, string>();
/** Each Polaris account's language. */
const locales = new Map<string, string>();

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findUnique: async () => ({
                ownerId: "owner",
                name: "S",
                catalogId: "minecraft",
                status: "running",
                config: JSON.stringify(config)
            }),
            findMany: async () => [{ id: "srv", ownerId: "owner", config: JSON.stringify(config) }],
            updateMany: async ({
                where,
                data
            }: {
                where: { config: string };
                data: { config: string };
            }) => {
                if (where.config !== JSON.stringify(config)) return { count: 0 };
                config = JSON.parse(data.config) as Record<string, unknown>;
                return { count: 1 };
            }
        },
        minecraftChallengePlayer: {
            findMany: async ({ where }: { where: { player?: { in: string[] } } }) =>
                [...players.values()].filter(
                    (one) => !where.player || where.player.in.includes(one.player)
                ),
            upsert: async ({
                create,
                update
            }: {
                create: { player: string; playerName: string; data: string };
                update: { playerName: string; data: string };
            }) => {
                players.set(create.player, {
                    player: create.player,
                    ...(players.has(create.player) ? update : create)
                });
            },
            deleteMany: async ({ where }: { where: { player: string } }) =>
                void players.delete(where.player)
        },
        minecraftChallengeLedger: {
            findUnique: async ({
                where
            }: {
                where: { scope_holder: { scope: string; holder: string } };
            }) => ledgers.get(`${where.scope_holder.scope}|${where.scope_holder.holder}`) ?? null,
            findMany: async ({ where }: { where: { scope: string | { in: string[] } } }) =>
                [...ledgers.values()].filter((one) =>
                    typeof where.scope === "string"
                        ? one.scope === where.scope
                        : where.scope.in.includes(one.scope)
                ),
            create: async ({ data }: { data: { scope: string; holder: string; data: string } }) => {
                const key = `${data.scope}|${data.holder}`;
                if (ledgers.has(key)) throw new Error("Unique constraint failed");
                ledgers.set(key, data);
            },
            updateMany: async ({
                where,
                data
            }: {
                where: { scope: string; holder: string; data: string };
                data: { data: string };
            }) => {
                const key = `${where.scope}|${where.holder}`;
                if (ledgers.get(key)?.data !== where.data) return { count: 0 };
                ledgers.set(key, { scope: where.scope, holder: where.holder, data: data.data });
                return { count: 1 };
            }
        },
        gamePlayerLink: {
            findMany: async () =>
                [...links.entries()].map(([player, userId]) => ({ player, userId }))
        },
        minecraftAnticheatFlag: { groupBy: async () => [] }
    }
}));

vi.mock("@polaris/app-host", () => ({
    host: {
        appsInstallConfig: {
            readInstallConfig: (raw: string | null) =>
                raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
        },
        i18nLocaleService: {
            getUserLocale: async (userId: string) => locales.get(userId) ?? "en-US",
            storedLocale: async (userId: string) => locales.get(userId) ?? null
        }
    }
}));

vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    editionOf: () => "java",
    openServerContainer: async () => ({ server, close: async () => undefined }),
    withServerContainer: async (
        _o: string,
        _i: string,
        work: (s: typeof server) => Promise<unknown>
    ) => work(server)
}));

vi.mock("@polaris-app/game-servers/src/lib/minecraft/live-display-service", () => ({
    holdSidebar: () => undefined,
    releaseSidebar: () => undefined
}));

const service = await import(
    "@polaris-app/game-servers/src/lib/minecraft/challenges/challenges-service"
);
const stored = await import("@polaris-app/game-servers/src/lib/minecraft/challenges/state");
const { readEventState } = await import("@polaris-app/game-servers/src/lib/minecraft/events/state");
const { forgetActivity } = await import("@polaris-app/game-servers/src/lib/minecraft/activity");
const speechService = await import("@polaris-app/game-servers/src/lib/minecraft/speech-service");

const START = Date.parse("2026-09-29T12:00:00Z");
const record = (name: string) =>
    stored.readPlayer(players.get(name.toLowerCase())!.data, name, Date.now());
const state = () => stored.readServerState(config);
const settingsOf = () => service.settingsOf(config);
const PUMPKIN = "minecraft.mined:minecraft.pumpkin";
const PLACED = "minecraft.used:minecraft.pumpkin";
const ZOMBIE = "minecraft.killed:minecraft.zombie";

/** Time moves on, the players move (or not), and the loop reads. */
async function step(seconds: number, moving: readonly string[] = []): Promise<void> {
    vi.setSystemTime(Date.now() + seconds * 1000);
    for (const name of moving) fake.move(name, 3, 10);
    await service.runTick("srv", Date.now(), true);
}

/** A known pool for today: pumpkins, wheat, zombies. */
function knownPool(): void {
    const current = state();
    config = {
        ...config,
        challengeState: {
            ...current,
            daily: {
                ...current.daily!,
                pool: [
                    { template: "F4", variant: null, tier: "easy", target: 3 },
                    { template: "F1", variant: null, tier: "medium", target: 5 },
                    { template: "C2", variant: "zombie", tier: "hard", target: 3 },
                    { template: "F5", variant: null, tier: "medium", target: 4 }
                ],
                applied: false
            }
        }
    };
    players.clear();
}

beforeEach(async () => {
    vi.useFakeTimers({ now: START });
    fake = new FakeServer();
    config = {
        challenges: {
            enabled: true,
            timezone: "UTC",
            language: "en",
            eligibility: { minMinutes: 0 },
            antiExploit: { afkMinutes: 1 }
        }
    };
    players.clear();
    ledgers.clear();
    links.clear();
    locales.clear();
    speechService.forget("srv");
    forgetActivity();
    await service.stopAllLoops();
    fake.join("Alba", 0, 0);
    fake.join("Bruno", 100, 0);
    await service.sweepChallenges(Date.now());
});

afterEach(async () => {
    await service.stopAllLoops();
    vi.useRealTimers();
});

describe("challenges on a server", () => {
    it("draws the day, week and card, makes their objectives, and deals three to each player", async () => {
        await step(1);
        await step(16, ["Alba", "Bruno"]);
        const drawn = state();
        expect(drawn.daily?.pool).toHaveLength(9);
        expect(drawn.weekly?.pool).toHaveLength(6);
        expect(drawn.card?.pool).toHaveLength(9);
        expect(fake.objectives.has("pc_d0")).toBe(true);
        expect(fake.objectives.has("pc_menu")).toBe(true);
        expect([...fake.objectives.keys()].every((name) => /^(pc_|pe_)/.test(name))).toBe(true);
        expect(record("Alba").daily?.instances).toHaveLength(3);
        expect(record("Bruno").weekly?.instances).toHaveLength(3);
        expect(record("Alba").card?.instances).toHaveLength(9);
    });

    it("leaves out statistics the version does not have, and a challenge left with nothing to count", async () => {
        fake = new FakeServer();
        fake.join("Alba");
        for (const id of ["deepslate", "tuff", "pumpkin", "melon"]) {
            fake.unknown.add(`minecraft.mined:minecraft.${id}`);
            fake.unknown.add(`minecraft.used:minecraft.${id}`);
        }
        knownPool();
        await step(1);
        expect(state().daily!.refused).toContain(PUMPKIN);
        expect(state().daily!.pool.some((one) => one.template === "F4")).toBe(false);
    });

    it("counts real work, not place-and-break, and pays it with levels and points", async () => {
        knownPool();
        await step(1);
        await step(16, ["Alba"]);
        expect(record("Alba").daily!.instances.map((one) => one.template)).toEqual([
            "F4",
            "F1",
            "C2"
        ]);
        // Placed and broken three times over.
        fake.add("Alba", PLACED, 3);
        fake.add("Alba", PUMPKIN, 3);
        await step(16, ["Alba"]);
        expect(record("Alba").daily!.instances[0]!.progress).toBe(0);
        // Three grown ones.
        fake.add("Alba", PUMPKIN, 3);
        await step(16, ["Alba"]);
        const done = record("Alba").daily!.instances[0]!;
        expect(done.doneAt).not.toBeNull();
        expect(fake.heard).toContain("xp add Alba 1 levels");
        expect(fake.heard.some((line) => line.startsWith("title Alba title"))).toBe(true);
        expect(fake.heard.some((line) => line.includes("ui.toast.challenge_complete"))).toBe(true);
        const ledger = JSON.parse([...ledgers.values()][0]!.data) as { points: number };
        expect(ledger.points).toBe(10);
    });

    it("keeps a reward for somebody whose own things an event still holds", async () => {
        knownPool();
        await step(1);
        await step(16, ["Alba"]);
        // Sent home from an arena, still falling: everything of hers is away.
        config = {
            ...config,
            eventState: {
                arenaLeftovers: [
                    {
                        id: "old",
                        kind: "team-duel",
                        arena: null,
                        marker: "components",
                        kit: [],
                        entrants: [
                            {
                                name: "Alba",
                                uuid: null,
                                dimension: "minecraft:overworld",
                                x: 1,
                                y: 64,
                                z: 1,
                                yaw: 0,
                                pitch: 0,
                                gamemode: "survival",
                                side: 0
                            }
                        ],
                        createdAt: Date.now()
                    }
                ]
            }
        };
        fake.add("Alba", PUMPKIN, 3);
        await step(16, ["Alba"]);
        expect(record("Alba").daily!.instances[0]!.doneAt).not.toBeNull();
        // Not handed over now, where it would take the slot one of her own
        // stacks goes back into: it waits in the queue with the events' prizes.
        expect(fake.heard).not.toContain("xp add Alba 1 levels");
        expect(
            readEventState(config).pending.some(
                (one) => one.player === "Alba" && one.reward.levels === 1
            )
        ).toBe(true);
    });

    it("credits nothing that rose while the player stood still", async () => {
        knownPool();
        await step(1);
        await step(16, ["Alba"]);
        // Two minutes without moving or turning, then an auto-clicker's kills.
        await step(16);
        await step(16);
        await step(16);
        await step(16);
        fake.add("Alba", ZOMBIE, 3);
        await step(16);
        const afk = record("Alba").daily!.instances[2]!;
        expect(afk.raw).toBe(3);
        expect(afk.progress).toBe(0);
        // Back at the keyboard: what they kill now counts.
        await step(16, ["Alba"]);
        fake.add("Alba", ZOMBIE, 3);
        await step(16, ["Alba"]);
        expect(record("Alba").daily!.instances[2]!.doneAt).not.toBeNull();
    });

    it("answers the menu button, tracks a challenge and swaps one, counting from now", async () => {
        knownPool();
        await step(1);
        await step(16, ["Alba"]);
        fake.set("Alba", "pc_menu", 1);
        await service.runTick("srv", Date.now(), false);
        const menu = fake.heard.filter((line) => line.startsWith("tellraw Alba"));
        expect(menu.some((line) => line.includes("Harvest 3 pumpkins and melons"))).toBe(true);
        expect(fake.scores.get("Alba")!.get("pc_menu")).toBe(0);
        fake.set("Alba", "pc_menu", 20);
        await service.runTick("srv", Date.now(), false);
        expect(record("Alba").tracked).toBe("daily:0");
        expect(
            fake.heard.some((line) => line.startsWith("bossbar set polaris:pc_alba players Alba"))
        ).toBe(true);
        // Bone meal was used before the swap: it does not count for the new one.
        fake.add("Alba", "minecraft.used:minecraft.bone_meal", 4);
        fake.set("Alba", "pc_menu", 11);
        await service.runTick("srv", Date.now(), false);
        const swapped = record("Alba").daily!.instances[1]!;
        expect(swapped.template).toBe("F5");
        expect(record("Alba").daily!.rerolls).toBe(1);
        await step(16, ["Alba"]);
        expect(record("Alba").daily!.instances[1]!.progress).toBe(0);
        fake.add("Alba", "minecraft.used:minecraft.bone_meal", 4);
        await step(16, ["Alba"]);
        expect(record("Alba").daily!.instances[1]!.doneAt).not.toBeNull();
        // One swap a day.
        fake.set("Alba", "pc_menu", 12);
        await service.runTick("srv", Date.now(), false);
        expect(record("Alba").daily!.instances[2]!.template).toBe("C2");
    });

    it("answers each player in the language of their own Polaris account", async () => {
        links.set("alba", "user-es");
        locales.set("user-es", "es-ES");
        knownPool();
        await step(1);
        await step(16, ["Alba", "Bruno"]);
        expect(fake.heard).toContain("tag Alba add pl_es");
        fake.set("Alba", "pc_menu", 1);
        fake.set("Bruno", "pc_menu", 1);
        await service.runTick("srv", Date.now(), false);
        const to = (name: string) =>
            fake.heard.filter((line) => line.startsWith(`tellraw ${name} `));
        expect(to("Alba").some((line) => line.includes("Cosecha 5 de trigo"))).toBe(true);
        expect(to("Alba").some((line) => line.includes("Harvest 5 wheat"))).toBe(false);
        expect(to("Bruno").some((line) => line.includes("Harvest 5 wheat"))).toBe(true);
        expect(to("Bruno").some((line) => line.includes("Cosecha"))).toBe(false);
        // Nothing still carries a message in every language on its way out.
        expect(
            fake.heard.some((line) => line.includes('{"polaris":"') || /\ue000/.test(line))
        ).toBe(false);
    });

    it("speaks the owner's language to whoever Polaris has no language for, after the switch saved the settings", async () => {
        // The operator's server: owner Spanish, events never chose, challenges
        // switched on from the screen - which saves everything it shows.
        await service.stopAllLoops();
        speechService.forget("srv");
        config = {};
        locales.set("owner", "es-ES");
        locales.set("user-en", "en-US");
        links.set("alba", "user-en");
        // Linked to an account that has never had a language worked out.
        links.set("bruno", "user-new");
        fake.join("Carla", 50, 0);
        const shown = await service.challengesView("srv");
        expect(shown.automaticLanguage).toBe("es");
        await service.saveSettings("srv", {
            ...shown.settings,
            enabled: true,
            eligibility: { ...shown.settings.eligibility, minMinutes: 0 }
        });
        expect(settingsOf().serverLanguage).toBeNull();
        // Its first look, taken at once, drew the day.
        await vi.waitFor(async () =>
            expect((await service.challengesView("srv")).version).not.toBeNull()
        );
        knownPool();
        await step(1);
        await step(16, ["Alba", "Bruno", "Carla"]);
        expect(fake.heard).toContain("tag Bruno add pl_es");
        expect(fake.heard).toContain("tag Carla add pl_es");
        expect(fake.heard).toContain("tag Alba add pl_en");
        for (const name of ["Alba", "Bruno", "Carla"]) fake.set(name, "pc_menu", 1);
        await service.runTick("srv", Date.now(), false);
        const to = (name: string) =>
            fake.heard.filter((line) => line.startsWith(`tellraw ${name} `));
        for (const name of ["Bruno", "Carla"]) {
            expect(to(name).some((line) => line.includes("Cosecha 5 de trigo"))).toBe(true);
            expect(to(name).some((line) => line.includes("Harvest"))).toBe(false);
        }
        expect(to("Alba").some((line) => line.includes("Harvest 5 wheat"))).toBe(true);
        expect(to("Alba").some((line) => line.includes("Cosecha"))).toBe(false);
    });

    it("shows the community goal's bar to each language's readers, named in theirs", async () => {
        links.set("alba", "user-es");
        locales.set("user-es", "es-ES");
        await step(1);
        await step(16, ["Alba", "Bruno"]);
        expect(state().goals.length).toBeGreaterThan(0);
        expect(fake.heard).toContain("bossbar set polaris:pc_goal_es players @a[tag=pl_es]");
        expect(fake.heard).toContain("bossbar set polaris:pc_goal_en players @a[tag=!pl_es]");
        const named = (id: string) =>
            fake.heard.find((line) => line.startsWith(`bossbar set ${id} name `)) ?? "";
        expect(named("polaris:pc_goal_es")).toMatch(/Comunidad|comunidad/);
        expect(named("polaris:pc_goal_en")).toMatch(/Community|community/);
        // Nobody reads Spanish any more: its bar is taken down, not left on them.
        links.clear();
        speechService.forget("srv");
        fake.heard.length = 0;
        await step(16, ["Alba", "Bruno"]);
        expect(fake.heard).toContain("bossbar remove polaris:pc_goal_es");
        expect(fake.heard).toContain("bossbar set polaris:pc_goal_en players @a[tag=!pl_es]");
    });

    it("answers a player by their own name through a team's prefix and suffix, and a Bedrock player by theirs", async () => {
        knownPool();
        await step(1);
        fake.join(".Bo");
        await step(16, ["Alba", ".Bo"]);
        fake.displays.set("Alba", "[VIP] Alba [AFK]");
        fake.set("Alba", "pc_menu", 1);
        fake.set(".Bo", "pc_menu", 1);
        fake.heard.length = 0;
        await service.runTick("srv", Date.now(), false);
        expect(
            fake.heard.some((line) => line.startsWith("tellraw Alba ") && line.includes("Harvest"))
        ).toBe(true);
        expect(
            fake.heard.some((line) => line.startsWith("tellraw .Bo ") && line.includes("Harvest"))
        ).toBe(true);
        expect(fake.heard.some((line) => /^tellraw (Bo|AFK|VIP)/.test(line))).toBe(false);
        expect(fake.scores.get("Alba")!.get("pc_menu")).toBe(0);
        expect(fake.scores.get(".Bo")!.get("pc_menu")).toBe(0);
    });

    it("keeps an offline player's progress, and pays what they finished offline into the queue at the new day", async () => {
        knownPool();
        await step(1);
        await step(16, ["Alba", "Bruno"]);
        fake.add("Bruno", PUMPKIN, 1);
        await step(16, ["Alba", "Bruno"]);
        expect(record("Bruno").daily!.instances[0]!.progress).toBe(1);
        // Two more, then gone before the next read.
        fake.add("Bruno", PUMPKIN, 2);
        fake.players.get("Bruno")!.online = false;
        await step(16, ["Alba"]);
        expect(record("Bruno").daily!.instances[0]!.progress).toBe(1);
        // The day ends with Bruno away: his scores are read off the scoreboard.
        vi.setSystemTime(Date.parse("2026-09-30T00:00:30Z"));
        await service.runTick("srv", Date.now(), true);
        expect(state().daily!.key).toBe("2026-09-30");
        const bruno = record("Bruno");
        expect(bruno.daily!.instances[0]!.doneAt).not.toBeNull();
        expect(bruno.backlog.map((one) => one.template)).toEqual(["F1", "C2"]);
        expect(
            readEventState(config).pending.some(
                (one) => one.player === "Bruno" && one.reward.levels === 1
            )
        ).toBe(true);
        // Yesterday's objectives were made again: everybody counts from 0.
        expect(fake.scores.get("Bruno")?.get("pc_d0")).toBeUndefined();
        expect(state().outcomes.some((one) => one.template === "F4" && one.done === 1)).toBe(true);
    });

    it("moves yesterday's unfinished challenges to the backlog once, dealt again to count from the new day", async () => {
        knownPool();
        await step(1);
        await step(16, ["Alba"]);
        fake.add("Alba", PUMPKIN, 3);
        fake.add("Alba", ZOMBIE, 1);
        await step(16, ["Alba"]);
        expect(record("Alba").daily!.instances[0]!.doneAt).not.toBeNull();
        expect(record("Alba").daily!.instances[2]!.progress).toBe(1);
        vi.setSystemTime(Date.parse("2026-09-30T00:00:30Z"));
        await service.runTick("srv", Date.now(), true);
        await step(16, ["Alba"]);
        await step(16, ["Alba"]);
        const alba = record("Alba");
        expect(alba.daily!.key).toBe("2026-09-30");
        expect(alba.backlog).toHaveLength(2);
        expect(new Set(alba.backlog.map((one) => one.template)).size).toBe(2);
        expect(
            alba.backlog.every(
                (one) =>
                    one.day === "2026-09-29" && one.dealtAt >= Date.parse("2026-09-30T00:00:00Z")
            )
        ).toBe(true);
    });

    it("never sends anything that breaks, places, removes or takes", async () => {
        knownPool();
        await step(1);
        await step(16, ["Alba", "Bruno"]);
        fake.add("Alba", PUMPKIN, 3);
        fake.set("Alba", "pc_menu", 1);
        await step(16, ["Alba", "Bruno"]);
        vi.setSystemTime(Date.parse("2026-09-30T00:00:30Z"));
        await service.runTick("srv", Date.now(), true);
        for (const line of fake.heard) {
            expect(line).not.toMatch(
                /^(setblock|fill |kill |summon |item replace|data (merge|modify|remove)|xp set|tp |teleport )/
            );
            expect(line).not.toMatch(/^clear \S+( \S+( [1-9]\d*)?)?$/);
            expect(line).not.toMatch(/objectives remove (?!pc_)/);
            expect(Buffer.byteLength(line)).toBeLessThanOrEqual(1014);
        }
    });

    it("counts an event's results towards taking part and the podium", async () => {
        const current = state();
        config = {
            ...config,
            challengeState: {
                ...current,
                weekly: {
                    ...current.weekly!,
                    pool: [
                        { template: "S2", variant: null, tier: "easy", target: 1 },
                        { template: "S3", variant: null, tier: "medium", target: 1 },
                        { template: "F1", variant: null, tier: "hard", target: 50 }
                    ],
                    applied: false
                }
            }
        };
        players.clear();
        await step(1);
        await step(16, ["Alba"]);
        expect(record("Alba").weekly!.instances.map((one) => one.template)).toEqual([
            "S2",
            "S3",
            "F1"
        ]);
        await service.creditEventResults("srv", {
            participants: 1,
            ranked: ["Alba"],
            podium: ["Alba"],
            rounds: {}
        });
        expect(record("Alba").weekly!.instances[0]!.raw).toBe(0);
        await service.creditEventResults("srv", {
            participants: 3,
            ranked: ["Alba"],
            podium: ["Alba"],
            rounds: {}
        });
        await step(16, ["Alba"]);
        expect(record("Alba").weekly!.instances[0]!.doneAt).not.toBeNull();
        expect(record("Alba").weekly!.instances[1]!.doneAt).not.toBeNull();
    });

    it("counts a shared season from the day the group already counts from", async () => {
        config = {
            ...config,
            challenges: {
                ...(config.challenges as object),
                shared: { enabled: true, group: "Hub" }
            }
        };
        ledgers.set("group:owner:hub|season", {
            scope: "group:owner:hub",
            holder: "season",
            data: JSON.stringify({ start: "2026-09-01" })
        });
        links.set("alba", "u1");
        knownPool();
        await step(1);
        await step(16, ["Alba"]);
        fake.add("Alba", PUMPKIN, 3);
        await step(16, ["Alba"]);
        const ledger = JSON.parse(ledgers.get("group:owner:hub|user:u1")!.data) as {
            season: string;
            points: number;
        };
        expect(ledger.season).toBe("2026-09-01#1");
        expect(ledger.points).toBe(10);
    });

    it("takes down a week's objectives and a tracked bar when switched off with no day running", async () => {
        config = {
            ...config,
            challenges: { ...(config.challenges as object), layers: { daily: false, card: false } }
        };
        await step(1);
        await step(16, ["Alba"]);
        expect(state().daily).toBeNull();
        expect(state().weekly?.applied).toBe(true);
        fake.set("Alba", "pc_menu", 23);
        await service.runTick("srv", Date.now(), false);
        expect(record("Alba").tracked).toBe("weekly:0");
        await service.stopAllLoops();
        config = { ...config, challenges: { ...(config.challenges as object), enabled: false } };
        fake.heard.length = 0;
        await service.sweepChallenges(Date.now());
        expect([...fake.objectives.keys()].filter((name) => name.startsWith("pc_"))).toEqual([]);
        expect(fake.heard).toContain("bossbar remove polaris:pc_alba");
    });

    it("starts at once when switched on from the screen, and says Running with the version", async () => {
        await service.stopAllLoops();
        config = {};
        fake = new FakeServer();
        fake.join("Alba");
        const off = await service.challengesView("srv");
        expect(off.running).toBe(false);
        expect(off.version).toBeNull();
        await service.saveSettings("srv", { ...off.settings, enabled: true });
        // Running straight away - not on the next minute's sweep.
        expect((await service.challengesView("srv")).running).toBe(true);
        await vi.waitFor(async () => {
            const on = await service.challengesView("srv");
            expect(on.version).toBe("1.21.4");
            expect(on.running).toBe(true);
            expect(on.idle).toBeNull();
        });
        expect(fake.objectives.has("pc_menu")).toBe(true);
    });

    it("says the server is stopped when switched on while it is", async () => {
        await service.stopAllLoops();
        config = {};
        const off = await service.challengesView("srv");
        server.running = false;
        try {
            await service.saveSettings("srv", { ...off.settings, enabled: true });
            await vi.waitFor(async () => {
                const view = await service.challengesView("srv");
                expect(view.idle).toBe("stopped");
                expect(view.running).toBe(false);
            });
        } finally {
            server.running = true;
        }
        // Back up: the next sweep starts it, and it no longer says why it waits.
        await service.sweepChallenges(Date.now());
        await service.runTick("srv", Date.now(), true);
        const view = await service.challengesView("srv");
        expect(view.running).toBe(true);
        expect(view.idle).toBeNull();
    });

    it("takes its objectives down when switched off", async () => {
        await step(1);
        expect(fake.objectives.size).toBeGreaterThan(1);
        config = { ...config, challenges: { ...(config.challenges as object), enabled: false } };
        await service.runTick("srv", Date.now(), true);
        expect([...fake.objectives.keys()].filter((name) => name.startsWith("pc_"))).toEqual([]);
    });
});
