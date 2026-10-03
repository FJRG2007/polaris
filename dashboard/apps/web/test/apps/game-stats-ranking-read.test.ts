/**
 * The playtime leaderboard, read the way the server is really read.
 *
 * A real server: seven stats files, 110 KB between them, and the host
 * daemon answers a command with 16 KiB. Read as one answer, the leaderboard had
 * the one player whose file came first - somebody with an hour and a half - and
 * not the owner with eighty hours. The fake cuts where the daemon cuts.
 */

import { describe, expect, it, vi } from "vitest";
import { filesAnswer } from "./container-fake";

const LIMIT = 16 * 1024;

/** Stats files as the game writes them, padded to the sizes a real server's had. */
function statsFile(ticks: number, pad: number, alive = 0): string {
    return JSON.stringify({
        stats: {
            "minecraft:custom": {
                "minecraft:play_time": ticks,
                "minecraft:deaths": 1,
                "minecraft:time_since_death": alive
            }
        },
        DataVersion: 4189,
        padding: "x".repeat(pad)
    });
}

const DIR = "/data/world/stats";
const files: Record<string, string> = {
    [`${DIR}/11111111-1111-3111-8111-111111111111.json`]: statsFile(119_463, 4_300),
    [`${DIR}/44444444-4444-3444-8444-444444444444.json`]: statsFile(2_584_666, 20_500),
    [`${DIR}/55555555-5555-3555-8555-555555555555.json`]: statsFile(3_119_889, 25_600),
    [`${DIR}/77777777-7777-4777-8777-777777777777.json`]: statsFile(26_912, 200, 72_000),
    [`${DIR}/aaaaaaaa-aaaa-3aaa-8aaa-aaaaaaaaaaaa.json`]: statsFile(2_425_468, 25_800),
    [`${DIR}/eeeeeeee-eeee-3eee-8eee-eeeeeeeeeeee.json`]: statsFile(5_752_132, 32_500, 1_872_000),
    "/data/usercache.json": JSON.stringify([
        { name: "DINNERBONE", uuid: "44444444-4444-3444-8444-444444444444" },
        {
            name: "PlayerOne",
            uuid: "eeeeeeee-eeee-3eee-8eee-eeeeeeeeeeee",
            expiresOn: "2026-08-02 10:00:00 +0000"
        },
        { name: "Grumm", uuid: "aaaaaaaa-aaaa-3aaa-8aaa-aaaaaaaaaaaa" },
        { name: "Jeb_04", uuid: "55555555-5555-3555-8555-555555555555" },
        { name: "Notch", uuid: "11111111-1111-3111-8111-111111111111" },
        {
            name: "PlayerOne",
            uuid: "77777777-7777-4777-8777-777777777777",
            expiresOn: "2026-10-27 18:04:12 +0000"
        }
    ])
};

const cut = (text: string) => Buffer.from(text).subarray(0, LIMIT).toString("utf8");

const server = {
    edition: "java",
    applicationId: "app1",
    run: async (argv: readonly string[]) => {
        if (argv[0] === "cat") {
            const file = files[argv[2]!];
            return file === undefined
                ? { code: 1, output: "No such file or directory" }
                : { code: 0, output: cut(file) };
        }
        const batch = filesAnswer(argv, files, LIMIT);
        if (batch) return batch;
        const page = /sed -n '(\d+),(\d+)p'$/.exec(argv[2] ?? "");
        if (page) {
            const names = Object.keys(files)
                .filter((path) => path.startsWith(`${DIR}/`))
                .map((path) => path.slice(DIR.length + 1))
                .sort();
            const rows = names.slice(Number(page[1]) - 1, Number(page[2]));
            return { code: 0, output: cut(rows.map((row) => `${row}\n`).join("")) };
        }
        return { code: 1, output: "" };
    },
    readFile: async (path: string) => {
        const bytes = Buffer.from(files[path] ?? "");
        return new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array(bytes));
                controller.close();
            }
        });
    }
};

vi.mock("@polaris/app-host", () => ({
    host: {
        envVarService: {
            listEnvVars: async () => [{ key: "LEVEL", value: "world" }]
        }
    }
}));
/** Whether the container refuses to be reached, as a stopped or restarting
 *  server does. */
const reach = { down: false };

vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    withServerContainer: async (_owner: string, _id: string, work: (s: unknown) => unknown) => {
        if (reach.down) throw new Error("The server is not running");
        return work(server);
    }
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/world", async (importOriginal) => ({
    ...(await importOriginal<object>()),
    levelEnvKey: () => "LEVEL",
    DATA_DIR: "/data"
}));

const { readAllMining, readAllPlayerStats, readMinecraftStats } = await import(
    "@polaris-app/game-servers/src/lib/minecraft/stats-service"
);
const { statsRanking } = await import("@polaris-app/game-servers/src/lib/minecraft/rankings");

describe("the playtime leaderboard, read from the server", () => {
    it("has every player, longest first, and one row for a player filed under two uuids", async () => {
        const figures = await readAllPlayerStats("owner", "examplesmp");
        expect(statsRanking("rank.playtime", figures)).toEqual([
            "1. PlayerOne 80h",
            "2. Jeb_04 43h",
            "3. DINNERBONE 35h",
            "4. Grumm 33h",
            "5. Notch 1h"
        ]);
    });

    it("reads the current life from the uuid the player joined under last, not the longer", async () => {
        const figures = await readAllPlayerStats("owner", "examplesmp");
        expect(statsRanking("rank.alive", figures)).toEqual(["1. PlayerOne 1h"]);
    });

    it("gives one player's figures from every file they are filed under", async () => {
        const stats = await readMinecraftStats("owner", "examplesmp", "PlayerOne");
        expect(stats?.playedMs).toBe((5_752_132 + 26_912) * 50);
        expect(stats?.deaths).toBe(2);
    });
});

describe("a server that could not be read", () => {
    it("is read again on the next request rather than holding nothing for a minute", async () => {
        reach.down = true;
        expect(await readAllPlayerStats("owner", "restarting")).toEqual([]);
        expect(await readAllMining("owner", "restarting")).toEqual([]);
        reach.down = false;
        const figures = await readAllPlayerStats("owner", "restarting");
        expect(statsRanking("rank.playtime", figures)[0]).toBe("1. PlayerOne 80h");
    });
});
