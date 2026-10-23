/**
 * Following the last 24 hours of the query log: what the follower answers after
 * any number of appends, a moving window, a new day and a rewritten file is
 * exactly what one reader reading every file whole from the start answers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureDay, fixtureLine } from "./fixtures/query-log-day";

const readFile = vi.fn();
const runIn = vi.fn();
/** The runtime `getPorts` answers with now: credentials can change under a follower. */
const ports = { current: { readFile, runIn } };

vi.mock("@polaris/db", () => ({
    prisma: { application: { findUnique: async () => ({ target: {} }) } }
}));
vi.mock("@/lib/dns-blocker/service", () => ({
    DnsBlockerRefusal: class DnsBlockerRefusal extends Error {},
    engineRow: async () => ({ id: "e", ownerId: "o", applicationId: "a", status: "running" }),
    engineConfigCurrent: async () => true,
    readSettings: async () => ({ logDays: 2 })
}));
vi.mock("@/lib/deploy/runtime", () => ({ getPorts: async () => ports.current }));
vi.mock("@/lib/container-files-service", () => ({ resolveContainerName: async () => "engine" }));

const { QueryLogFollower } = await import("@/lib/dns-blocker/log-follow");
const { dnsInsights, seenDevices } = await import("@/lib/dns-blocker/insights");
const { QueryBar, QueryLogReader, parseQueryLine, queryFilterSchema, queryLogPath, rangeWindow } =
    await import("@/lib/dns-blocker/query-log");

const DAY = 86_400_000;
const TODAY = Date.parse("2026-10-23T00:00:00Z");
const { page: _page, ...UNFILTERED } = queryFilterSchema.parse({});

/** The day files as the engine holds them, by path. */
let files: Map<string, Buffer>;

const path = (day: number) => queryLogPath(new Date(day));
const append = (day: number, lines: readonly string[]) => {
    const held = files.get(path(day)) ?? Buffer.alloc(0);
    files.set(
        path(day),
        Buffer.concat([held, Buffer.from(lines.map((line) => `${line}\n`).join(""))])
    );
};

/** What one reader reading every file of the window whole answers. */
function fullRead(now: number) {
    const window = rangeWindow("24h", now);
    const reader = new QueryLogReader(UNFILTERED, window);
    for (const day of window.days) {
        const bytes = files.get(queryLogPath(day));
        if (!bytes) continue;
        const lines = new TextDecoder().decode(bytes).split("\n");
        const rest = lines.pop() ?? "";
        for (const line of lines) reader.add(line);
        reader.add(rest);
    }
    return reader;
}

type Reader = InstanceType<typeof QueryLogReader>;

function expectSame(followed: Reader, full: Reader) {
    expect(full.stats().queries).toBeGreaterThan(0);
    expect(followed.stats()).toEqual(full.stats());
    expect(followed.devices()).toEqual(full.devices());
    for (const page of [0, 1, 7, 49]) expect(followed.page(page)).toEqual(full.page(page));
}

/** Pieces of every awkward length, cut anywhere - mid-line and mid-character. */
const memorySource = (sizes: number[]) => ({
    async open(at: string, from: number) {
        const bytes = files.get(at);
        if (!bytes) return null;
        async function* pieces() {
            let offset = from;
            let turn = 0;
            while (offset < bytes!.length) {
                const size = sizes[turn++ % sizes.length]!;
                yield new Uint8Array(bytes!.subarray(offset, offset + size));
                offset += size;
            }
        }
        return { size: bytes.length, pieces: pieces() };
    }
});

/** A seeded run of lines between two times. */
function lines(from: number, to: number, count: number, seed: number): string[] {
    let state = seed;
    const pick = () => {
        state = (state * 1_664_525 + 1_013_904_223) >>> 0;
        return state / 2 ** 32;
    };
    return Array.from({ length: count }, (_, index) =>
        fixtureLine(from + Math.floor(((to - from) * index) / count), pick)
    );
}

beforeEach(() => {
    files = new Map();
    readFile.mockReset();
    runIn.mockReset();
    ports.current = { readFile, runIn };
});

describe("QueryLogFollower", () => {
    it("matches a full read over a busy day, with appends and a moving window", async () => {
        // Yesterday whole (90k lines, about 15 MB) and today up to 10:00.
        append(TODAY - DAY, fixtureDay(TODAY - DAY, 90_000, 1));
        expect(files.get(path(TODAY - DAY))!.length).toBeGreaterThan(14_000_000);
        append(TODAY, lines(TODAY, TODAY + 10 * 3_600_000, 37_500, 2));
        const follower = new QueryLogFollower(memorySource([65_536, 4_093, 11_000, 17]));
        let now = TODAY + 10 * 3_600_000;
        expectSame((await follower.read(rangeWindow("24h", now))).reader, fullRead(now));

        // A few asks later: a minute of lookups, then twenty, then an hour and
        // a half, each crossing into new bars and pushing old ones out.
        for (const [minutes, count, seed] of [
            [1, 60, 3],
            [20, 1_300, 4],
            [90, 5_600, 5]
        ] as const) {
            const next = now + minutes * 60_000;
            append(TODAY, lines(now, next, count, seed));
            now = next;
            expectSame((await follower.read(rangeWindow("24h", now))).reader, fullRead(now));
        }
    });

    it("starts a new day's file and lets the old day fall out of the window", async () => {
        append(TODAY - DAY, lines(TODAY - DAY, TODAY, 2_000, 6));
        const follower = new QueryLogFollower(memorySource([1_000]));
        let now = TODAY - 60_000;
        expectSame((await follower.read(rangeWindow("24h", now))).reader, fullRead(now));
        append(TODAY, lines(TODAY, TODAY + 3_600_000, 300, 7));
        now = TODAY + 3_600_000;
        expectSame((await follower.read(rangeWindow("24h", now))).reader, fullRead(now));
        // A day later the first file is past the window entirely.
        append(TODAY + DAY, lines(TODAY + DAY, TODAY + DAY + 600_000, 50, 8));
        now = TODAY + DAY + 600_000;
        expectSame((await follower.read(rangeWindow("24h", now))).reader, fullRead(now));
    });

    it("reads a file that got shorter again from its start", async () => {
        append(TODAY, lines(TODAY, TODAY + 3_600_000, 500, 9));
        const follower = new QueryLogFollower(memorySource([2_048]));
        const now = TODAY + 3_600_000;
        await follower.read(rangeWindow("24h", now));
        files.set(path(TODAY), Buffer.alloc(0));
        append(TODAY, lines(TODAY, TODAY + 3_600_000, 40, 10));
        expectSame((await follower.read(rangeWindow("24h", now))).reader, fullRead(now));
    });

    it("leaves a line still being written for the next ask", async () => {
        const [first, second] = lines(TODAY, TODAY + 60_000, 2, 11);
        files.set(path(TODAY), Buffer.from(`${first}\n${second!.slice(0, 40)}`));
        const follower = new QueryLogFollower(memorySource([7]));
        const now = TODAY + 120_000;
        expect((await follower.read(rangeWindow("24h", now))).reader.stats().queries).toBe(1);
        files.set(path(TODAY), Buffer.from(`${first}\n${second}\n`));
        expectSame((await follower.read(rangeWindow("24h", now))).reader, fullRead(now));
    });

    it("counts a name that is not plain ASCII the way a full read does", async () => {
        const [line] = lines(TODAY, TODAY + 1_000, 1, 12);
        const cells = line!.split("\t");
        cells[1] = "192.168.1.250";
        cells[2] = "salón-tele.lan";
        append(TODAY, [cells.join("\t"), ...lines(TODAY + 2_000, TODAY + 60_000, 30, 13)]);
        // Pieces of one byte cut every character of the name in two.
        const follower = new QueryLogFollower(memorySource([1]));
        const now = TODAY + 120_000;
        const followed = (await follower.read(rangeWindow("24h", now))).reader;
        expectSame(followed, fullRead(now));
        expect(followed.devices().some((device) => device.name === "salón-tele.lan")).toBe(true);
    });

    it("keeps only the busiest names of a bar the window moved past", async () => {
        // A bar of 900 lookups, each of a name of its own but the busiest.
        const named = (domain: string, line: string) => {
            const cells = line.split("	");
            cells[5] = domain;
            return cells.join("	");
        };
        const run = lines(TODAY, TODAY + 500_000, 900, 19).map((line, index) =>
            named(index % 3 === 0 ? "busy.example.test." : `rare-${index}.example.test.`, line)
        );
        append(TODAY, [...run, ...lines(TODAY + 3_600_000, TODAY + 3_660_000, 5, 20)]);
        const follower = new QueryLogFollower(memorySource([4_096]));
        const now = TODAY + 3_660_000;
        const followed = (await follower.read(rangeWindow("24h", now))).reader;
        const full = fullRead(now);
        expect(followed.stats().topPermitted[0]).toEqual(full.stats().topPermitted[0]);
        expect(followed.stats().topBlocked[0]).toEqual(full.stats().topBlocked[0]);
        expect(followed.stats().queries).toBe(full.stats().queries);

        const bar = new QueryBar(TODAY);
        for (const line of run) bar.add(parseQueryLine(line)!);
        expect(bar.permitted.size + bar.blockedDomains.size).toBeGreaterThan(500);
        bar.seal(50);
        expect(bar.permitted.size).toBeLessThanOrEqual(50);
        expect(bar.blockedDomains.size).toBeLessThanOrEqual(50);
        expect(bar.queries).toBe(900);
    });
});

/** The engine's container, running the commands the source sends it. */
function engineFake() {
    readFile.mockImplementation(async (_container: string, at: string) => {
        const bytes = files.get(at);
        if (!bytes) throw new Error("no such file");
        let offset = 0;
        return new ReadableStream<Uint8Array>({
            pull(controller) {
                if (offset >= bytes.length) return controller.close();
                controller.enqueue(new Uint8Array(bytes.subarray(offset, offset + 65_536)));
                offset += 65_536;
            }
        });
    });
    runIn.mockImplementation(async (_container: string, argv: string[]) => {
        if (argv[0] !== "sh") return { code: 0, output: "blocking enabled" };
        const [at, from, chunk, past] = argv.slice(4);
        const bytes = files.get(at!);
        if (!bytes) return { code: 1, output: "stat: can't stat" };
        const start = Number(from);
        const lines: string[] = [];
        if (past) {
            lines.push(String(bytes.length));
            if (!(bytes.length > start && bytes.length - start <= Number(past)))
                return { code: 0, output: `${lines.join("\n")}\n` };
        }
        const piece = bytes.subarray(start, start + Number(chunk)).toString("base64");
        // base64 wraps its lines at 76.
        lines.push(...(piece.match(/.{1,76}/g) ?? []));
        const output = `${lines.join("\n")}\n`;
        // What a command returns is cut at 16 KiB.
        expect(output.length).toBeLessThanOrEqual(16_384);
        return { code: 0, output };
    });
}

describe("dnsInsights, unfiltered", () => {
    it("streams the first read, then asks only for what was appended", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        engineFake();
        append(TODAY - DAY, lines(TODAY - DAY, TODAY, 20_000, 14));
        append(TODAY, lines(TODAY, TODAY + 3_600_000, 2_000, 15));
        let now = TODAY + 3_600_000;
        vi.setSystemTime(now);
        const filter = queryFilterSchema.parse({});
        const first = await dnsInsights(filter, true);
        // Both files were longer than a few commands' worth: streamed.
        expect(readFile).toHaveBeenCalledTimes(2);
        expect(first.stats).toEqual(fullRead(now).stats());

        // Five minutes on: three hundred lines, about 50 KB, a few commands.
        append(TODAY, lines(now, now + 300_000, 300, 16));
        now += 300_000;
        vi.setSystemTime(now);
        const after = await dnsInsights(filter, true);
        expect(readFile).toHaveBeenCalledTimes(2);
        expect(after.stats).toEqual(fullRead(now).stats());
        expect(after.log).toEqual(fullRead(now).page(0));
        const devices = await seenDevices("24h", true);
        expect(devices.devices).toEqual(fullRead(now).devices());
        vi.useRealTimers();
    });

    it("says nothing was there when neither file exists", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(TODAY + 3_600_000);
        engineFake();
        const result = await dnsInsights(queryFilterSchema.parse({}), true);
        expect(result.stats.queries).toBe(0);
        expect(readFile).not.toHaveBeenCalled();
        vi.useRealTimers();
    });

    it("reads through the runtime as it is now, not as it was on the first read", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        engineFake();
        append(TODAY, lines(TODAY, TODAY + 3_600_000, 200, 17));
        let now = TODAY + 3_600_000;
        vi.setSystemTime(now);
        const filter = queryFilterSchema.parse({});
        await dnsInsights(filter, true);

        // The host's address or key changed: the old connection is refused.
        const rotated = vi.fn(runIn.getMockImplementation());
        runIn.mockImplementation(async () => {
            throw new Error("old credentials");
        });
        ports.current = { readFile, runIn: rotated };
        append(TODAY, lines(now, now + 300_000, 50, 18));
        now += 300_000;
        vi.setSystemTime(now);
        const after = await dnsInsights(filter, true);
        expect(rotated).toHaveBeenCalled();
        expect(after.stats).toEqual(fullRead(now).stats());
        vi.useRealTimers();
    });
});
