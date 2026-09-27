/**
 * The playtime leaderboard, read the way the server is really read.
 *
 * Offgrid, 2026-09-27: seven stats files, 110 KB between them, and the host
 * daemon answers a command with 16 KiB. Read as one answer, the leaderboard had
 * the one player whose file came first - somebody with an hour and a half - and
 * not the owner with eighty hours. The fake cuts where the daemon cuts.
 */

import { describe, expect, it, vi } from "vitest";
import { filesAnswer } from "./container-fake";

const LIMIT = 16 * 1024;

/** Stats files as the game writes them, padded to the sizes Offgrid's had. */
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
    [`${DIR}/1b6b8f8d-bab0-31ec-81f0-3b688de1427b.json`]: statsFile(119_463, 4_300),
    [`${DIR}/4ffcd79a-00f0-320e-83ed-b7ee339805bd.json`]: statsFile(2_584_666, 20_500),
    [`${DIR}/566ef275-58fd-3496-b868-8bf93dfa1f6d.json`]: statsFile(3_119_889, 25_600),
    [`${DIR}/778ec1e8-ba87-46bc-a217-e543e6d40cf2.json`]: statsFile(26_912, 200, 72_000),
    [`${DIR}/a92884cc-f611-30ea-bd4a-4f985d5876d8.json`]: statsFile(2_425_468, 25_800),
    [`${DIR}/e5092d24-33f4-334a-8ad5-e0d5bfdc7d92.json`]: statsFile(5_752_132, 32_500, 1_872_000),
    "/data/usercache.json": JSON.stringify([
        { name: "PICHURRINA", uuid: "4ffcd79a-00f0-320e-83ed-b7ee339805bd" },
        {
            name: "FJRG2007",
            uuid: "e5092d24-33f4-334a-8ad5-e0d5bfdc7d92",
            expiresOn: "2026-08-02 10:00:00 +0000"
        },
        { name: "Reckmy", uuid: "a92884cc-f611-30ea-bd4a-4f985d5876d8" },
        { name: "ErMigue04", uuid: "566ef275-58fd-3496-b868-8bf93dfa1f6d" },
        { name: "Solojose", uuid: "1b6b8f8d-bab0-31ec-81f0-3b688de1427b" },
        {
            name: "FJRG2007",
            uuid: "778ec1e8-ba87-46bc-a217-e543e6d40cf2",
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
vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    withServerContainer: async (_owner: string, _id: string, work: (s: unknown) => unknown) =>
        work(server)
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/world", async (importOriginal) => ({
    ...(await importOriginal<object>()),
    levelEnvKey: () => "LEVEL",
    DATA_DIR: "/data"
}));

const { readAllPlayerStats, readMinecraftStats } = await import(
    "@polaris-app/game-servers/src/lib/minecraft/stats-service"
);
const { statsRanking } = await import("@polaris-app/game-servers/src/lib/minecraft/rankings");

describe("the playtime leaderboard, read from the server", () => {
    it("has every player, longest first, and one row for a player filed under two uuids", async () => {
        const figures = await readAllPlayerStats("owner", "offgrid");
        expect(statsRanking("rank.playtime", figures)).toEqual([
            "1. FJRG2007 80h",
            "2. ErMigue04 43h",
            "3. PICHURRINA 35h",
            "4. Reckmy 33h",
            "5. Solojose 1h"
        ]);
    });

    it("reads the current life from the uuid the player joined under last, not the longer", async () => {
        const figures = await readAllPlayerStats("owner", "offgrid");
        expect(statsRanking("rank.alive", figures)).toEqual(["1. FJRG2007 1h"]);
    });

    it("gives one player's figures from every file they are filed under", async () => {
        const stats = await readMinecraftStats("owner", "offgrid", "FJRG2007");
        expect(stats?.playedMs).toBe((5_752_132 + 26_912) * 50);
        expect(stats?.deaths).toBe(2);
    });
});
