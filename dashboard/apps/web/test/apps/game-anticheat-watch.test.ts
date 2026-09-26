/**
 * The movement watch on a running server: the loop the honeypots run in, now
 * also asking who is in the air and who jumped, against a fake game that answers
 * the way the real one does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
    config: {} as Record<string, unknown>,
    answer: (_command: string): string => "",
    run: (_argv: readonly string[]): { code: number; output: string } => ({ code: 1, output: "" }),
    notified: [] as string[]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findUnique: async () => ({
                config: JSON.stringify(fake.config),
                name: "Offgrid",
                status: "running",
                catalogId: "minecraft"
            }),
            findMany: async () => [],
            updateMany: async (input: { where: { config: string }; data: { config: string } }) => {
                if (input.where.config !== JSON.stringify(fake.config)) return { count: 0 };
                fake.config = JSON.parse(input.data.config) as Record<string, unknown>;
                return { count: 1 };
            }
        }
    }
}));
vi.mock("@polaris/app-host", () => ({
    host: {
        appsInstallConfig: { readInstallConfig: (raw: string) => JSON.parse(raw ?? "{}") },
        notificationService: {
            createNotification: async (input: { title: string }) => {
                fake.notified.push(input.title);
            }
        }
    }
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    withServerContainer: async (_owner: string, _id: string, work: (server: unknown) => unknown) =>
        work({
            running: true,
            edition: "java",
            say: async (argv: string[]) => fake.answer(argv[0] ?? ""),
            run: async (argv: readonly string[]) => fake.run(argv)
        })
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/timeout-service", () => ({
    timeoutPlayer: async () => undefined
}));

import { DEFAULT_XRAY_SETTINGS } from "@polaris-app/game-servers/src/lib/minecraft/xray";
import {
    AIRBORNE_COMMAND,
    RIDING_COMMAND
} from "@polaris-app/game-servers/src/lib/minecraft/movement";

const INSTALL = "018f2b7a-0000-7000-8000-0000000000e2";

interface Player {
    name: string;
    x: number;
    y: number;
    z: number;
    airborne?: boolean;
    riding?: boolean;
}

describe("watching movement", () => {
    let players: Player[] = [];
    let log = "";
    let ops: string[] = [];
    let logAdmin: boolean | null = true;
    let looks = 0;

    const entity = (one: Player, data: string) =>
        `${one.name} has the following entity data: ${data}`;
    const pos = (one: Player) => entity(one, `[${one.x}d, ${one.y}d, ${one.z}d]`);

    beforeEach(() => {
        vi.useFakeTimers();
        vi.resetModules();
        players = [];
        log = "";
        ops = [];
        logAdmin = true;
        looks = 0;
        fake.notified.length = 0;
        fake.answer = (command) => {
            if (command === "execute as @a run data get entity @s Pos") {
                looks += 1;
                return players.map(pos).join("\n");
            }
            if (command === "execute as @a run data get entity @s Dimension")
                return players.map((one) => entity(one, '"minecraft:overworld"')).join("\n");
            if (command === AIRBORNE_COMMAND)
                return players
                    .filter((one) => one.airborne)
                    .map(pos)
                    .join("\n");
            if (command === RIDING_COMMAND)
                return players
                    .filter((one) => one.riding)
                    .map((one) => entity(one, '"minecraft:overworld"'))
                    .join("\n");
            if (command === "gamerule logAdminCommands")
                return logAdmin === null
                    ? "Unknown or incomplete command"
                    : `Gamerule logAdminCommands is currently set to: ${logAdmin}`;
            return "";
        };
        fake.run = (argv) => {
            if (argv[0] === "stat") return { code: 0, output: `${log.length}\n` };
            if (argv[0] === "sh" && argv[2]?.startsWith("tail"))
                return { code: 0, output: log.slice(Number(argv[4]) - 1).slice(-Number(argv[5])) };
            if (argv[0] === "cat")
                return {
                    code: 0,
                    output: JSON.stringify(ops.map((name) => ({ name, uuid: "x" })))
                };
            return { code: 1, output: "" };
        };
        fake.config = {
            xrayTraps: {
                settings: { ...DEFAULT_XRAY_SETTINGS, enabled: false, movement: true },
                honeypots: [],
                evidence: {},
                cleanup: []
            }
        };
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    async function start() {
        const service = await import("@polaris-app/game-servers/src/lib/minecraft/xray-service");
        service.startXrayTraps("owner", INSTALL);
    }

    async function look() {
        const before = looks;
        await vi.advanceTimersByTimeAsync(4_100);
        expect(looks, "the loop looked").toBeGreaterThan(before);
    }

    function incidents(name: string): { kind: string }[] {
        const stored = fake.config.xrayTraps as {
            movement?: Record<string, { incidents: { kind: string }[] }>;
        };
        return stored.movement?.[name.toLowerCase()]?.incidents ?? [];
    }

    it("records a player hovering without being allowed to fly, once per flight", async () => {
        await start();
        for (let index = 0; index < 6; index += 1) {
            players = [{ name: "Steve", x: index * 3, y: 100, z: 0, airborne: true }];
            await look();
        }
        expect(incidents("Steve").map((one) => one.kind)).toEqual(["flying"]);
    });

    it("never records an operator", async () => {
        ops = ["Steve"];
        await start();
        for (let index = 0; index < 5; index += 1) {
            players = [{ name: "Steve", x: index * 3, y: 100, z: 0, airborne: true }];
            await look();
        }
        players = [{ name: "Steve", x: 5000, y: 100, z: 0 }];
        await look();
        expect(incidents("Steve")).toEqual([]);
    });

    it("records a jump nothing in the log explains", async () => {
        await start();
        players = [{ name: "Alex", x: 0, y: 64, z: 0 }];
        await look();
        await look();
        players = [{ name: "Alex", x: 3000, y: 64, z: 0 }];
        await look();
        expect(incidents("Alex").map((one) => one.kind)).toEqual(["teleport"]);
    });

    it("does not record a jump an operator made with /tp", async () => {
        await start();
        players = [{ name: "Alex", x: 0, y: 64, z: 0 }];
        await look();
        await look();
        log += "[12:00:01] [Server thread/INFO]: [Admin: Teleported Alex to 3000.0, 64.0, 0.0]\n";
        players = [{ name: "Alex", x: 3000, y: 64, z: 0 }];
        await look();
        expect(incidents("Alex")).toEqual([]);
    });

    it("does not record a jump whose /tp was logged while the look was being taken", async () => {
        await start();
        players = [{ name: "Alex", x: 0, y: 64, z: 0 }];
        await look();
        await look();
        const answer = fake.answer;
        fake.answer = (command) => {
            if (command === RIDING_COMMAND && players[0]?.x === 0) {
                log +=
                    "[12:00:01] [Server thread/INFO]: [Admin: Teleported Alex to 3000.0, 64.0, 0.0]\n";
                players = [{ name: "Alex", x: 3000, y: 64, z: 0 }];
            }
            return answer(command);
        };
        await look();
        await look();
        expect(incidents("Alex")).toEqual([]);
    });

    it("does not record a jump on a horse", async () => {
        await start();
        players = [{ name: "Alex", x: 0, y: 64, z: 0, riding: true }];
        await look();
        await look();
        players = [{ name: "Alex", x: 3000, y: 64, z: 0, riding: true }];
        await look();
        expect(incidents("Alex")).toEqual([]);
    });

    it("stands the teleport check down, and says why, while operators' commands are not logged", async () => {
        logAdmin = false;
        await start();
        players = [{ name: "Alex", x: 0, y: 64, z: 0 }];
        await look();
        await look();
        players = [{ name: "Alex", x: 3000, y: 64, z: 0 }];
        await look();
        expect(incidents("Alex")).toEqual([]);
        expect((fake.config.xrayTraps as { teleportCheck: string | null }).teleportCheck).toMatch(
            /logAdminCommands/
        );
    });

    it("stands the teleport check down, and says why, when the server does not answer about logging", async () => {
        logAdmin = null;
        await start();
        players = [{ name: "Alex", x: 0, y: 64, z: 0 }];
        await look();
        await look();
        players = [{ name: "Alex", x: 3000, y: 64, z: 0 }];
        await look();
        expect(incidents("Alex")).toEqual([]);
        expect((fake.config.xrayTraps as { teleportCheck: string | null }).teleportCheck).toMatch(
            /did not say/
        );
    });

    it("tells the owner once a player looks likely to be cheating", async () => {
        await start();
        let x = 0;
        for (let flight = 0; flight < 2; flight += 1) {
            for (let index = 0; index < 4; index += 1) {
                x += 3;
                players = [{ name: "Steve", x, y: 100, z: 0, airborne: true }];
                await look();
            }
            players = [{ name: "Steve", x, y: 64, z: 0 }];
            await look();
        }
        expect(incidents("Steve")).toHaveLength(2);
        expect(fake.notified).toEqual(["Steve may be flying or teleporting on Offgrid"]);
    });
});
