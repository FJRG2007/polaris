/**
 * Reading today's lookups off the engine: one read of the file shared for a few
 * seconds, a missing file told apart from an engine that is not recording, and a
 * failed engine command said as the engine not answering.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const readFile = vi.fn();
const runIn = vi.fn();
const engineConfigCurrent = vi.fn(async () => true);

vi.mock("@polaris/db", () => ({
    prisma: { application: { findUnique: async () => ({ target: {} }) } }
}));
vi.mock("@/lib/dns-blocker/service", () => ({
    DnsBlockerRefusal: class DnsBlockerRefusal extends Error {
        constructor(readonly code: string) {
            super(code);
        }
    },
    engineRow: async () => ({ id: "e", ownerId: "o", applicationId: "a", status: "running" }),
    engineConfigCurrent
}));
vi.mock("@/lib/deploy/runtime", () => ({ getPorts: async () => ({ readFile, runIn }) }));
vi.mock("@/lib/container-files-service", () => ({ resolveContainerName: async () => "engine" }));

const { dnsInsights, engineMetrics, tailQueries } = await import("@/lib/dns-blocker/insights");
const { queryFilterSchema } = await import("@/lib/dns-blocker/query-log");

const LINE = [
    new Date(Date.now() - 60_000).toISOString().slice(0, 19).replace("T", " "),
    "10.0.0.2",
    "10.0.0.2",
    "3",
    "reason",
    "example.com.",
    "1.2.3.4",
    "NOERROR",
    "RESOLVED",
    "A",
    "x"
].join("\t");

function file(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
        }
    });
}

const filter = queryFilterSchema.parse({});

beforeEach(() => {
    readFile.mockReset();
    runIn.mockReset();
    runIn.mockResolvedValue({ code: 0, output: "blocking enabled" });
    engineConfigCurrent.mockReset();
    engineConfigCurrent.mockResolvedValue(true);
});

describe("dnsInsights", () => {
    it("reads the day's file once for the same filter, and again when asked fresh", async () => {
        readFile.mockImplementation(async () => file(`${LINE}\n`));
        const search = { ...filter, search: "once" };
        await dnsInsights(search);
        const perRead = readFile.mock.calls.length;
        // The last 24 hours touch today's file and yesterday's.
        expect(perRead).toBe(2);
        await dnsInsights(search);
        expect(readFile).toHaveBeenCalledTimes(perRead);
        await dnsInsights(search, true);
        expect(readFile).toHaveBeenCalledTimes(perRead * 2);
    });

    it("says the log is off when the file is missing and the engine runs an older config", async () => {
        readFile.mockRejectedValue(new Error("no such file"));
        engineConfigCurrent.mockResolvedValue(false);
        const result = await dnsInsights({ ...filter, search: "off" }, true);
        expect(result.logOff).toBe(true);
        expect(result.stats.queries).toBe(0);
    });

    it("reads a missing file as a quiet day when the engine is current", async () => {
        readFile.mockRejectedValue(new Error("no such file"));
        const result = await dnsInsights({ ...filter, search: "quiet" }, true);
        expect(result.logOff).toBe(false);
    });

    it("counts the lookups it reads", async () => {
        readFile.mockImplementation(async () => file(`${LINE}\n${LINE}`));
        const result = await dnsInsights({ ...filter, search: "count" }, true);
        // The same two lines in both days' files.
        expect(result.stats.queries).toBe(4);
        expect(result.logOff).toBe(false);
        expect(engineConfigCurrent).not.toHaveBeenCalled();
    });

    it("refuses a failed engine command as not answering", async () => {
        readFile.mockImplementation(async () => file(""));
        runIn.mockResolvedValue({ code: 1, output: "connection refused" });
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        await expect(dnsInsights({ ...filter, search: "fail" }, true)).rejects.toMatchObject({
            code: "notAnswering"
        });
    });
});

describe("tailQueries", () => {
    it("reads only the end of today's file and drops the cut first line", async () => {
        runIn.mockResolvedValue({
            code: 0,
            output: ["x".repeat(12_000), LINE, ""].join(String.fromCharCode(10))
        });
        const rows = await tailQueries(filter);
        expect(runIn.mock.calls[0]?.[1]).toEqual([
            "tail",
            "-c",
            "12000",
            expect.stringMatching(/^\/logs\/.+_ALL\.log$/)
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.domain).toBe("example.com");
    });

    it("reads a missing file as nothing asked yet", async () => {
        runIn.mockResolvedValue({ code: 1, output: "No such file" });
        expect(await tailQueries(filter)).toEqual([]);
    });
});

describe("engineMetrics", () => {
    it("reads the list counts off the engine's loopback", async () => {
        runIn.mockResolvedValue({
            code: 0,
            output: [
                'blocky_denylist_cache_entries{group="ads"} 120',
                "blocky_last_list_group_refresh_timestamp_seconds 1.7e+09"
            ].join(String.fromCharCode(10))
        });
        const metrics = await engineMetrics();
        expect(metrics?.listed).toBe(120);
        expect(metrics?.lastRefresh).toBe(1.7e12);
        const command = runIn.mock.calls[0]?.[1] as string[];
        expect(command.slice(0, 2)).toEqual(["sh", "-c"]);
        expect(command[2]).toContain("http://127.0.0.1:4000/metrics");
    });

    it("is null when the engine predates its metrics", async () => {
        runIn.mockResolvedValue({ code: 1, output: "wget: server returned error: HTTP/1.1 404" });
        expect(await engineMetrics()).toBeNull();
    });
});
