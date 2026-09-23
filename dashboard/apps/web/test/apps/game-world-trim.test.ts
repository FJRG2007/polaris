/**
 * Optimizing a world: when Polaris may do it, and what it makes of the answer.
 *
 * The part that reads region files is a Python script that runs inside the server
 * container, and it was verified against a real 585 MB world - 55,790 chunks of
 * 78,373 had never been stood in, every kept chunk came out byte for byte
 * identical, and a real Minecraft 1.21.4 server booted on the result. What is
 * pinned here is everything around it: the rules that decide whether it runs at
 * all, which are the ones that could quietly turn a background job into something
 * that stops somebody's server.
 */

import { describe, expect, it } from "vitest";
import {
    describeTrim,
    readTrimReport,
    readWorldTrim,
    readWorldTrimRun,
    trimDue,
    WORLD_TRIM_DEFAULTS,
    WORLD_TRIM_KEY,
    WORLD_TRIM_RUN_KEY
} from "@polaris-app/game-servers/src/lib/minecraft/world-trim";
import { WORLD_TRIM_SCRIPT } from "@polaris-app/game-servers/src/lib/minecraft/world-trim-script";

const stopped = { running: false, edition: "java" as const };

describe("the settings a server carries", () => {
    it("is on for a server that has never been near the screen", () => {
        // The whole point of the default: the worlds worth optimizing are the old
        // ones nobody has been administering.
        expect(readWorldTrim({}).enabled).toBe(true);
        expect(readWorldTrim({})).toEqual(WORLD_TRIM_DEFAULTS);
    });

    it("keeps every chunk anybody has stood in, by default", () => {
        // Nought ticks is the only threshold that needs no judgement about how
        // long a visit is. Anything higher starts deciding that for people.
        expect(WORLD_TRIM_DEFAULTS.keepTicks).toBe(0);
    });

    it("reads back what was saved", () => {
        const stored = { [WORLD_TRIM_KEY]: { enabled: false, keepTicks: 200, keepRadius: 4, everyDays: 30 } };
        expect(readWorldTrim(stored)).toEqual({
            enabled: false,
            keepTicks: 200,
            keepRadius: 4,
            everyDays: 30
        });
    });

    it("falls back rather than throwing on a blob written by hand", () => {
        expect(readWorldTrim({ [WORLD_TRIM_KEY]: "on" })).toEqual(WORLD_TRIM_DEFAULTS);
        expect(readWorldTrim({ [WORLD_TRIM_KEY]: { keepTicks: -5, everyDays: 0 } }).keepTicks).toBe(0);
        expect(readWorldTrim({ [WORLD_TRIM_KEY]: { everyDays: 10_000 } }).everyDays).toBe(365);
    });

    it("says nothing about a server that has never run one", () => {
        expect(readWorldTrimRun({})).toBeNull();
        expect(readWorldTrimRun({ [WORLD_TRIM_RUN_KEY]: { removed: 4 } })).toBeNull();
    });
});

describe("when Polaris may do it on its own", () => {
    it("never touches a server that is up", () => {
        // The one rule that makes the default defensible. A running server holds
        // its region files open, and a world rewritten underneath one is a world
        // the server then writes back through a table that no longer fits it.
        expect(trimDue(WORLD_TRIM_DEFAULTS, null, new Date(), { running: true, edition: "java" })).toBe(false);
    });

    it("does not stop a server to get the chance", () => {
        // Stated as the absence of any way to ask: the only input about the
        // server is whether it is already down.
        expect(trimDue(WORLD_TRIM_DEFAULTS, null, new Date(), stopped)).toBe(true);
    });

    it("leaves Bedrock alone", () => {
        // Bedrock keeps its world in a key-value store, so there are no region
        // files to read and nothing here would find anything to do.
        expect(trimDue(WORLD_TRIM_DEFAULTS, null, new Date(), { running: false, edition: "bedrock" })).toBe(
            false
        );
    });

    it("does nothing when it has been switched off", () => {
        expect(trimDue({ ...WORLD_TRIM_DEFAULTS, enabled: false }, null, new Date(), stopped)).toBe(false);
    });

    it("waits out the gap between runs", () => {
        const now = new Date("2026-09-23T12:00:00.000Z");
        const yesterday = {
            at: "2026-09-22T12:00:00.000Z",
            ok: true,
            removed: 10,
            freedBytes: 1024,
            detail: ""
        };
        expect(trimDue(WORLD_TRIM_DEFAULTS, yesterday, now, stopped)).toBe(false);
        const longAgo = { ...yesterday, at: "2026-08-01T12:00:00.000Z" };
        expect(trimDue(WORLD_TRIM_DEFAULTS, longAgo, now, stopped)).toBe(true);
    });

    it("waits out the same gap after a run that failed", () => {
        // Whatever stopped it - no python in the image, a daemon too old - will
        // still be true in a minute, and a sweep that retries every minute is a
        // log full of one sentence.
        const now = new Date("2026-09-23T12:00:00.000Z");
        const failed = {
            at: "2026-09-23T11:00:00.000Z",
            ok: false,
            removed: 0,
            freedBytes: 0,
            detail: "python3: not found"
        };
        expect(trimDue(WORLD_TRIM_DEFAULTS, failed, now, stopped)).toBe(false);
    });
});

describe("what the container printed", () => {
    const line = JSON.stringify({
        world: "/data/world",
        dryRun: true,
        dimensions: 2,
        regions: 117,
        kept: 22583,
        removed: 55790,
        freedBytes: 399739561,
        skipped: []
    });

    it("reads the report", () => {
        const report = readTrimReport(line);
        expect(report?.removed).toBe(55790);
        expect(report?.kept).toBe(22583);
        expect(report?.dryRun).toBe(true);
    });

    it("finds it under whatever the image printed first", () => {
        // The script prints one line of JSON; the image around it has opinions.
        expect(readTrimReport(`[init] setting up\n${line}`)?.removed).toBe(55790);
    });

    it("is null when there is no report, however much output there was", () => {
        expect(readTrimReport("python3: command not found")).toBeNull();
        expect(readTrimReport("")).toBeNull();
        // Valid JSON that is not a report is not a report.
        expect(readTrimReport('{"ok":true}')).toBeNull();
    });

    it("says what happened in one sentence", () => {
        const report = readTrimReport(line);
        expect(report && describeTrim(report)).toContain("55,790 chunks");
        const nothing = readTrimReport(JSON.stringify({ removed: 0, freedBytes: 0 }));
        expect(nothing && describeTrim(nothing)).toContain("Nothing to take out");
    });
});

describe("the script that goes into the container", () => {
    it("keeps a chunk it cannot read rather than guessing", () => {
        // The rule the whole thing rests on, asserted against the script itself
        // because it is the one sentence that must never be edited away.
        expect(WORLD_TRIM_SCRIPT).toContain('"I could not tell" is never allowed to mean "delete it"');
    });

    it("needs nothing that is not already in the image", () => {
        const imports = [...WORLD_TRIM_SCRIPT.matchAll(/^import (\w+)/gm)].map((match) => match[1]);
        expect(imports.sort()).toEqual(["argparse", "gzip", "json", "os", "struct", "sys", "zlib"]);
    });

    it("never writes over a world file in place", () => {
        // Each region file is rebuilt beside itself and moved over the original,
        // so a run that is killed halfway leaves the world as it was.
        expect(WORLD_TRIM_SCRIPT).toContain("os.replace(temporary, path)");
    });
});
