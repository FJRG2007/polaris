/**
 * The rules a log viewer reads a stream by: which level a line is, which lines
 * are the same line repeated, and where a search hits.
 */

import { describe, expect, it } from "vitest";
import {
    countBuckets,
    foldRepeats,
    levelOf,
    matchRanges,
    parseLog,
    stripAnsi,
    type LogEntry
} from "../../src/lib/log-lines";

function entries(...texts: string[]): LogEntry[] {
    return texts.map((text) => ({ text, level: "default", time: null }));
}

describe("level detection", () => {
    it("reads the level a Minecraft server declares in its thread block", () => {
        expect(levelOf("[12:00:01] [Server thread/INFO]: Done (3.2s)!")).toBe("info");
        expect(levelOf("[12:00:01] [Server thread/WARN]: Can't keep up!")).toBe("warn");
        expect(levelOf("[12:00:01] [Server thread/ERROR]: Encountered an unexpected exception")).toBe("error");
    });

    it("lets the declared level outrank the words in the message", () => {
        expect(levelOf("[12:00:01] [Server thread/INFO]: Player failed to connect")).toBe("info");
        expect(levelOf("[12:00:01] [Worker-Main-2/WARN]: Everything is ready")).toBe("warn");
    });

    it("reads the NeoForge format, with its date and logger blocks", () => {
        const line = "[11Oct2026 12:00:01.123] [Server thread/FATAL] [net.minecraft.server.Main/]: Crashed";
        expect(levelOf(line)).toBe("error");
    });

    it("reads JSON and logfmt level fields", () => {
        expect(levelOf('{"level":"warn","msg":"slow query"}')).toBe("warn");
        expect(levelOf('{"severity": "ERROR", "message": "boom"}')).toBe("error");
        expect(levelOf("time=2026-10-11T10:00:00Z level=error msg=\"db down\"")).toBe("error");
        expect(levelOf('ts=1 level="debug" msg="tick"')).toBe("info");
    });

    it("falls back to the words when nothing is declared", () => {
        expect(levelOf("TypeError: x is not a function")).toBe("error");
        expect(levelOf("DeprecationWarning: Buffer() is deprecated")).toBe("warn");
        expect(levelOf("just some output")).toBe("default");
    });

    it("ignores a bracketed path that is not a level", () => {
        expect(levelOf("[GET /api/health] 200")).toBe("default");
    });

    it("strips terminal colour codes before reading the line", () => {
        const coloured = "\u001b[33m[12:00:01] [Server thread/WARN]: low memory\u001b[0m";
        expect(stripAnsi(coloured)).toBe("[12:00:01] [Server thread/WARN]: low memory");
        const [entry] = parseLog(coloured);
        expect(entry).toMatchObject({ text: "[12:00:01] [Server thread/WARN]: low memory", level: "warn" });
    });

    it("counts a line that names no level as info", () => {
        const counts = countBuckets(parseLog("plain\n[12:00:01] [Server thread/ERROR]: x\nwarning: y"));
        expect(counts).toEqual({ error: 1, warn: 1, info: 1 });
    });
});

describe("folding repeats", () => {
    it("folds consecutive identical lines into one with a count", () => {
        const rows = foldRepeats(entries("a", "b", "b", "b", "c"));
        expect(rows.map((row) => [row.entry.text, row.repeat])).toEqual([
            ["a", 1],
            ["b", 3],
            ["c", 1]
        ]);
    });

    it("compares lines without the timestamp they start with, keeping the last", () => {
        const rows = foldRepeats(
            entries(
                "[12:00:01] [Server thread/INFO]: [Rcon: Changed display name to Alex for polaris.line.01]",
                "[12:00:05] [Server thread/INFO]: [Rcon: Changed display name to Alex for polaris.line.01]",
                "[12:00:09] [Server thread/INFO]: [Rcon: Changed display name to Alex for polaris.line.01]"
            )
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ repeat: 3, span: 1 });
        expect(rows[0]?.entry.text.startsWith("[12:00:09]")).toBe(true);
    });

    it("folds an alternating block, like an RCON client starting and shutting down", () => {
        const started = "[12:00:01] [RCON Listener #1/INFO]: Thread RCON Client /127.0.0.1 started";
        const stopped = "[12:00:01] [RCON Client /127.0.0.1 #2/INFO]: Thread RCON Client /127.0.0.1 shutting down";
        const rows = foldRepeats(entries("boot", started, stopped, started, stopped, started, stopped, "done"));
        expect(rows.map((row) => [row.entry.text, row.repeat, row.span, row.offset])).toEqual([
            ["boot", 1, 1, 0],
            [started, 3, 2, 0],
            [stopped, 3, 2, 1],
            ["done", 1, 1, 0]
        ]);
    });

    it("prefers the single line over a block when both cover the same run", () => {
        const rows = foldRepeats(entries("a", "a", "a", "a"));
        expect(rows).toEqual([{ entry: expect.objectContaining({ text: "a" }), repeat: 4, span: 1, offset: 0 }]);
    });

    it("leaves lines that do not repeat alone", () => {
        expect(foldRepeats(entries("a", "b", "a", "c")).map((row) => row.repeat)).toEqual([1, 1, 1, 1]);
        expect(foldRepeats([])).toEqual([]);
    });

    it("stays fast on tens of thousands of lines", () => {
        const many = entries(...Array.from({ length: 50_000 }, (_, index) => `line ${index % 7 === 0 ? "x" : index}`));
        const started = performance.now();
        foldRepeats(many);
        expect(performance.now() - started).toBeLessThan(1000);
    });
});

describe("search", () => {
    it("finds every occurrence, ignoring case", () => {
        expect(matchRanges("Error: an ERROR occurred", "error")).toEqual([
            [0, 5],
            [10, 15]
        ]);
    });

    it("finds nothing for an empty query or a miss", () => {
        expect(matchRanges("anything", "")).toEqual([]);
        expect(matchRanges("anything", "zzz")).toEqual([]);
    });
});
