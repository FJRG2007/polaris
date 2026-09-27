/**
 * A side panel that moves, on a running server.
 *
 * Between the loop's reads of its values, a panel with an effect or a line that
 * takes turns is drawn again every half second from what was last read - and
 * only what changed goes to the server, as one command to the container rather
 * than one per line. A panel that does not move is not drawn between ticks at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
    sidebar: {} as Record<string, unknown>,
    said: [] as string[],
    batches: [] as string[][]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findUnique: async () => ({
                name: "Survival",
                catalogId: "minecraft",
                status: "running",
                config: JSON.stringify({ mcRelease: "1.21.1", sidebar: fake.sidebar })
            })
        }
    }
}));
vi.mock("@polaris/app-host", () => ({
    host: {
        appsInstallConfig: {
            readInstallConfig: (raw: string) => JSON.parse(raw ?? "{}"),
            patchInstallConfig: async () => undefined
        },
        chatCalls: {
            voicePresence: async () => new Map(),
            subscribeMeetingEvents: async () => () => undefined
        }
    }
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    editionOf: () => "java",
    onlinePlayers: async () => null,
    withServerContainer: async (_owner: string, _id: string, work: (server: unknown) => unknown) =>
        work({
            running: true,
            edition: "java",
            say: async (argv: string[]) => {
                fake.said.push(argv[0] ?? "");
            },
            run: async (argv: string[]) => {
                const encoded = /^printf %s (\S+) \| base64 -d \| rcon-cli$/.exec(
                    argv[2] ?? ""
                )?.[1];
                if (!encoded) return { code: 1, output: "" };
                fake.batches.push(
                    Buffer.from(encoded, "base64").toString("utf8").trim().split("\n")
                );
                return { code: 0, output: "" };
            }
        })
}));

const live = await import("@polaris-app/game-servers/src/lib/minecraft/live-display-service");

const plain = (text: string) => ({
    frames: [text],
    every: 5,
    effect: { kind: "none", speed: 1000, colors: [], width: 20 }
});

beforeEach(() => {
    vi.useFakeTimers();
    // A real date, on a whole number of turns: the loop measures its periods from
    // the epoch, the way it does in production.
    vi.setSystemTime(1_700_000_000_000);
    fake.said = [];
    fake.batches = [];
});

afterEach(() => {
    vi.useRealTimers();
});

describe("a panel that moves", () => {
    it("is drawn again between ticks, only what changed, in one command each time", async () => {
        fake.sidebar = {
            enabled: true,
            title: plain("Polaris"),
            lines: [
                plain("Online"),
                { ...plain("Deaths"), frames: ["Deaths", "Kills"], every: 2 },
                {
                    ...plain("&6Shiny line"),
                    effect: { kind: "shine", speed: 500, colors: ["#ffffff"], width: 20 }
                }
            ]
        };
        live.startLiveDisplay("owner", "moving");
        await vi.advanceTimersByTimeAsync(2_100);
        // The first draw writes the whole panel.
        expect(fake.said.some((line) => line.includes("polaris.line.01"))).toBe(true);

        // Past the next turn, and long enough for the shine to have moved.
        await vi.advanceTimersByTimeAsync(5_000);
        expect(fake.batches.length).toBeGreaterThan(0);
        for (const batch of fake.batches) {
            // Never the lines that stand still.
            expect(batch.some((line) => line.includes("polaris.line.01"))).toBe(false);
            expect(batch.every((line) => line.startsWith("scoreboard players display name"))).toBe(
                true
            );
        }
        // The shine moved, and the turning line turned.
        expect(fake.batches.flat().some((line) => line.includes("polaris.line.03"))).toBe(true);
        expect(fake.batches.flat().some((line) => line.includes('"Kills"'))).toBe(true);
    });

    it("is not drawn between ticks when nothing on it moves", async () => {
        fake.sidebar = { enabled: true, title: "Polaris", lines: ["Online", "Still"] };
        live.startLiveDisplay("owner", "still");
        await vi.advanceTimersByTimeAsync(2_100);
        await vi.advanceTimersByTimeAsync(3_000);
        expect(fake.batches).toEqual([]);
    });
});
