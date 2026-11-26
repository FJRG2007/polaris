/**
 * The performance log: lines carry only numbers and short tokens, the file
 * rotates by size into one previous file, a flood is capped and counted, the
 * main-process look writes only past its threshold, and the page's reports are
 * checked before they are written.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { activeSummary, checkLoop, perfLine, PerfLog, perfValue, writePageReport, type DelayHistogram } from "@/main/perf-log";

let folder: string;
beforeEach(() => void (folder = mkdtempSync(join(tmpdir(), "perf-log-"))));
afterEach(() => rmSync(folder, { recursive: true, force: true }));

const AT = new Date("2026-11-26T10:00:00.000Z");

function histogram(p99Ms: number, maxMs: number): DelayHistogram & { resets: number; } {
    return {
        resets: 0,
        percentile: () => p99Ms * 1e6,
        max: maxMs * 1e6,
        reset() {
            this.resets += 1;
        }
    };
}

function recorder() {
    const lines: Array<[string, Record<string, unknown>]> = [];
    return { lines, write: async (event: string, fields: Record<string, unknown> = {}) => void lines.push([event, fields]) };
}

describe("a line", () => {
    it("rounds numbers and keeps only short tokens", () => {
        expect(perfLine(AT, "loop", { p99: 812.6, ok: true })).toBe("2026-11-26T10:00:00.000Z loop p99=813 ok=1");
        expect(perfValue(Number.NaN)).toBe("-");
        expect(perfValue("")).toBe("-");
    });

    it("can never carry a path, an address or spaces", () => {
        const value = perfValue("C:\\Users\\someone\\game.exe https://example.test/a b");
        expect(value).not.toMatch(/[\\/ ]/);
        expect(value.length).toBeLessThanOrEqual(64);
    });
});

describe("the file", () => {
    it("is made with its folder and appended to", async () => {
        const file = join(folder, "logs", "perf.log");
        const log = new PerfLog(file, { now: () => AT });
        await log.write("start", { version: "0.1.116" });
        await log.write("loop", { p99: 300 });
        expect(readFileSync(file, "utf8")).toBe("2026-11-26T10:00:00.000Z start version=0.1.116\n2026-11-26T10:00:00.000Z loop p99=300\n");
    });

    it("rotates into one previous file and never grows past the limit", async () => {
        const file = join(folder, "perf.log");
        let minute = 0;
        const log = new PerfLog(file, { maxBytes: 200, linesPerMinute: 1, now: () => new Date(AT.getTime() + minute++ * 60_000) });
        for (let i = 0; i < 20; i++) await log.write("loop", { p99: 1000 + i });
        expect(statSync(file).size).toBeLessThanOrEqual(200);
        expect(statSync(`${file}.1`).size).toBeLessThanOrEqual(200);
        expect(existsSync(`${file}.2`)).toBe(false);
        expect(readFileSync(file, "utf8")).toContain("p99=1019");
    });

    it("caps a flood and says how many lines it dropped", async () => {
        const file = join(folder, "perf.log");
        let now = AT;
        const log = new PerfLog(file, { linesPerMinute: 2, now: () => now });
        for (let i = 0; i < 5; i++) await log.write("page", { ms: i });
        now = new Date(AT.getTime() + 60_000);
        await log.write("page", { ms: 9 });
        const lines = readFileSync(file, "utf8").trim().split("\n");
        expect(lines).toHaveLength(4);
        expect(lines[2]).toContain("dropped lines=3");
        expect(lines[3]).toContain("ms=9");
    });

    it("never rejects when the file cannot be written", async () => {
        // The folder itself as the file: every append fails.
        const log = new PerfLog(folder);
        await expect(log.write("start")).resolves.toBeUndefined();
    });
});

describe("the main process's look", () => {
    it("writes nothing under the threshold and starts a fresh count", () => {
        const seen = histogram(40, 120);
        const log = recorder();
        expect(checkLoop(seen, log, () => [], 250)).toBe(false);
        expect(log.lines).toHaveLength(0);
        expect(seen.resets).toBe(1);
    });

    it("writes the delay and what the process waited on past it", () => {
        const log = recorder();
        expect(checkLoop(histogram(812, 20_113), log, () => ["Timeout", "FSReqPromise", "Timeout"], 250)).toBe(true);
        expect(log.lines).toEqual([["loop", { p99: 812, max: 20_113, active: "Timeout:2,FSReqPromise:1" }]]);
    });

    it("still writes the delay when the waiting list cannot be read", () => {
        const log = recorder();
        checkLoop(histogram(900, 900), log, () => {
            throw new Error("not here");
        });
        expect(log.lines).toEqual([["loop", { p99: 900, max: 900 }]]);
    });

    it("keeps the five most common kinds", () => {
        expect(activeSummary(["a", "b", "c", "d", "e", "f", "f"]).split(",")).toHaveLength(5);
        expect(activeSummary([])).toBe("");
    });
});

describe("the page's report", () => {
    it("splits a slow input into waiting, handlers and the frame", () => {
        const log = recorder();
        expect(writePageReport(log, { kind: "event", name: "click", duration: 20_000, delay: 40, processing: 10 })).toBe(true);
        expect(log.lines).toEqual([["page", { kind: "event", ms: 20_000, name: "click", delay: 40, processing: 10, present: 19_950 }]]);
    });

    it("writes a long task", () => {
        const log = recorder();
        writePageReport(log, { kind: "longtask", duration: 700 });
        expect(log.lines).toEqual([["page", { kind: "longtask", ms: 700 }]]);
    });

    it.each([
        ["an unknown kind", { kind: "paint", duration: 1 }],
        ["a name that is not an event's", { kind: "event", duration: 600, name: "https://example.test" }],
        ["an extra field", { kind: "longtask", duration: 600, url: "x" }],
        ["a negative time", { kind: "longtask", duration: -1 }],
        ["nothing", null]
    ])("refuses %s", (_label, raw) => {
        const log = recorder();
        expect(writePageReport(log, raw)).toBe(false);
        expect(log.lines).toHaveLength(0);
    });
});
