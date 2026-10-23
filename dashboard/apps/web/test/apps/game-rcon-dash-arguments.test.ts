/**
 * A command whose arguments start with a dash, sent over RCON.
 *
 * rcon-cli takes a leading dash for one of its own flags, so a teleport to a
 * negative coordinate (`tp Steve -555 23 252`) came back as "unknown shorthand
 * flag: '5' in -555" and never reached the game. Such a command is sent after
 * `--`; every other one keeps its exact shape.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
    edition: "minecraft" as string,
    runs: [] as string[][]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findFirst: async () => ({
                id: "mc",
                applicationId: "app",
                catalogId: fake.edition,
                config: "{}"
            })
        },
        application: {
            findFirst: async () => ({
                id: "app",
                desiredState: "running",
                sourceConfig: "{}",
                target: { id: "local" }
            })
        }
    }
}));

vi.mock("@polaris/app-host", () => {
    const ports = {
        runIn: (_container: string, argv: string[]) => {
            fake.runs.push(argv);
            return Promise.resolve({ code: 0, output: "" });
        },
        dispose: async () => undefined,
        readFile: async () => new ReadableStream(),
        trimWorld: null
    };
    const known: Record<string, Record<string, unknown>> = {
        deployRuntime: { getPorts: async () => ports },
        deployReleases: {
            currentReleaseRef: async () => ({ name: "polaris-mc", portSubject: "mc" })
        }
    };
    const stub = (name: string) =>
        new Proxy(known[name] ?? {}, {
            get: (target, key: string) => target[key] ?? (async () => undefined)
        });
    return { host: new Proxy({}, { get: (_target, name: string) => stub(name) }) };
});

const service = await import("@polaris-app/game-servers/src/lib/minecraft/service");

beforeEach(() => {
    fake.edition = "minecraft";
    fake.runs = [];
});

describe("a command with a negative number in it", () => {
    it("ends rcon-cli's flags before the command on Java", async () => {
        await service.runServerCommand("owner", "mc", ["tp", "Steve", "-555", "23", "252"]);
        expect(fake.runs).toEqual([["rcon-cli", "--", "tp", "Steve", "-555", "23", "252"]]);
    });

    it("leaves a command with no dash in it as it was", async () => {
        await service.runServerCommand("owner", "mc", ["tp", "Steve", "555", "23", "252"]);
        expect(fake.runs).toEqual([["rcon-cli", "tp", "Steve", "555", "23", "252"]]);
    });

    it("writes it to the console unchanged on Bedrock", async () => {
        fake.edition = "minecraft-bedrock";
        await service.runServerCommand("owner", "mc", ["tp", "Steve", "-555", "23", "252"]);
        expect(fake.runs).toEqual([["send-command", "tp", "Steve", "-555", "23", "252"]]);
    });
});
