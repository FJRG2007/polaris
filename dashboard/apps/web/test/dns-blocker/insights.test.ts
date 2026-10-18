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

const { dnsInsights } = await import("@/lib/dns-blocker/insights");

const LINE = [
    "2026-10-18 10:00:00",
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

const filter = { search: "", outcome: "all", client: "" } as const;

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
        await dnsInsights(search);
        expect(readFile).toHaveBeenCalledTimes(1);
        await dnsInsights(search, true);
        expect(readFile).toHaveBeenCalledTimes(2);
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
        expect(result.stats.queries).toBe(2);
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
