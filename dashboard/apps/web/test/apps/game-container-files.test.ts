/**
 * Reading a game server's files past what one command can answer.
 *
 * The host daemon cuts a command's output at 16 KiB and says nothing about it.
 * Offgrid's playtime leaderboard named one player of seven - the one whose file
 * came first - because every file was read as one answer. The fake here cuts the
 * way the daemon does, and serves `readFile` whole the way its stream does, so
 * each reader is held to getting everything, byte for byte.
 */

import { describe, expect, it } from "vitest";
import {
    RUN_OUTPUT_MAX,
    listContainerDir,
    readContainerFile,
    readContainerRange,
    readContainerTail,
    readLinesPaged
} from "@polaris-app/game-servers/src/lib/container-files";

/** Cut the way the daemon cuts: at the limit, back to a character boundary. */
function cut(text: string): string {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length <= RUN_OUTPUT_MAX) return text;
    let end = RUN_OUTPUT_MAX;
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    return bytes.subarray(0, end).toString("utf8");
}

function fakeServer(files: Record<string, string>, listing: string[] = []) {
    const runs: string[] = [];
    const server = {
        runs,
        run: async (argv: readonly string[]) => {
            runs.push(argv.join(" "));
            if (argv[0] === "cat") {
                const file = files[argv[2]!];
                return file === undefined
                    ? { code: 1, output: `cat: ${argv[2]}: No such file or directory` }
                    : { code: 0, output: cut(file) };
            }
            if (argv[0] === "stat") {
                const file = files[argv[4]!];
                return file === undefined
                    ? { code: 1, output: "" }
                    : { code: 0, output: `${Buffer.byteLength(file)}\n` };
            }
            const script = argv[2] ?? "";
            const range = /^tail -c \+(\d+) -- (\S+) \| head -c (\d+) \| base64$/.exec(script);
            if (range) {
                const bytes = Buffer.from(files[range[2]!] ?? "", "utf8");
                const start = Number(range[1]) - 1;
                const piece = bytes.subarray(start, start + Number(range[3]));
                // `base64` wraps at 76 columns.
                const encoded = piece.toString("base64").replace(/(.{76})/g, "$1\n");
                return { code: 0, output: cut(`${encoded}\n`) };
            }
            const page = /sed -n '(\d+),(\d+)p'$/.exec(script);
            if (page) {
                const sorted = [...listing].sort();
                const rows = sorted.slice(Number(page[1]) - 1, Number(page[2]));
                return { code: 0, output: cut(rows.map((row) => `${row}\n`).join("")) };
            }
            return { code: 1, output: "unexpected" };
        },
        readFile: async (path: string) => {
            const file = files[path];
            if (file === undefined) throw new Error("missing");
            const bytes = Buffer.from(file, "utf8");
            return new ReadableStream<Uint8Array>({
                start(controller) {
                    // In two chunks, as a stream arrives.
                    controller.enqueue(new Uint8Array(bytes.subarray(0, 7000)));
                    controller.enqueue(new Uint8Array(bytes.subarray(7000)));
                    controller.close();
                }
            });
        }
    };
    return server;
}

const big = (bytes: number) =>
    JSON.stringify({ stats: { "minecraft:custom": { "minecraft:play_time": 5752132 } } }) +
    " ".repeat(bytes);

describe("reading a whole file", () => {
    it("reads a file longer than one command answers, whole", async () => {
        const content = big(40_000);
        const server = fakeServer({ "/data/world/stats/a.json": content });
        expect(await readContainerFile(server as never, "/data/world/stats/a.json")).toBe(content);
    });

    it("reads a short file in one command, as before", async () => {
        const server = fakeServer({ "/data/ops.json": "[]" });
        expect(await readContainerFile(server as never, "/data/ops.json")).toBe("[]");
        expect(server.runs).toHaveLength(1);
    });

    it("tells a file that is not there", async () => {
        const server = fakeServer({});
        expect(await readContainerFile(server as never, "/data/ops.json")).toBeNull();
    });
});

describe("reading part of a file", () => {
    it("reads a stretch longer than one command answers, byte for byte, characters split between pieces included", async () => {
        const log = Array.from(
            { length: 3000 },
            (_, index) => `[12:00:${index}] Añadido ✉ línea ${index}\n`
        ).join("");
        const server = fakeServer({ "/data/logs/latest.log": log });
        const size = Buffer.byteLength(log);
        const from = 1234;
        expect(await readContainerRange(server as never, "/data/logs/latest.log", from, size)).toBe(
            Buffer.from(log, "utf8").subarray(from).toString("utf8")
        );
    });

    it("reads the end of a file, the part a cut answer loses", async () => {
        const log = `${"old line\n".repeat(8000)}Steve was slain by Zombie\n`;
        const server = fakeServer({ "/data/logs/latest.log": log });
        const tail = await readContainerTail(server as never, "/data/logs/latest.log", 65_536);
        expect(tail?.endsWith("Steve was slain by Zombie\n")).toBe(true);
        expect(Buffer.byteLength(tail!)).toBe(65_536);
    });
});

describe("listing", () => {
    it("lists every entry of a folder with more than one answer holds", async () => {
        const names = Array.from(
            { length: 700 },
            (_, index) => `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000.json`
        );
        const server = fakeServer({}, names);
        expect(await listContainerDir(server as never, "/data/world/stats")).toEqual(
            [...names].sort()
        );
    });

    it("pages any listing the same way", async () => {
        const paths = Array.from(
            { length: 400 },
            (_, index) => `/opt/resources/r${index}/fxmanifest.lua`
        );
        const server = fakeServer({}, paths);
        expect(await readLinesPaged(server as never, "find /opt/resources")).toHaveLength(400);
    });
});
