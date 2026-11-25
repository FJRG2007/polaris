/**
 * The startup log: one line per start, the newest kept, a step not reached read
 * as `-`, and nothing that can stop the app.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendStartupLine, startupLine, STARTUP_LOG_LINES, STARTUP_STEPS, withLine } from "@/main/startup-log";

/** A fresh module, as a new start has: its line is not written yet. */
async function freshStart() {
    vi.resetModules();
    return import("@/main/startup-log");
}

const LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \S+ (login|manual)( (bundle|ready|tray|window|painted|shown)=(\+\d+|-)){6}$/;

let folder: string;
beforeEach(() => void (folder = mkdtempSync(join(tmpdir(), "startup-log-"))));
afterEach(() => rmSync(folder, { recursive: true, force: true }));

describe("a start's line", () => {
    it("reads the process start, the version, how it started and every step in order", () => {
        const marks = new Map([
            ["bundle", 310.4],
            ["ready", 48_012],
            ["tray", 48_100],
            ["window", 48_250],
            ["painted", 49_001],
            ["shown", 49_010]
        ] as const);
        const line = startupLine({ origin: Date.UTC(2026, 10, 25, 10, 57, 8, 123), version: "0.1.111", login: true, marks });
        expect(line).toBe("2026-11-25T10:57:08.123Z 0.1.111 login bundle=+310 ready=+48012 tray=+48100 window=+48250 painted=+49001 shown=+49010");
        expect(line).toMatch(LINE);
    });

    it("says a step it never reached, as a start in the tray never shows", () => {
        const line = startupLine({ origin: 0, version: "0.1.111", login: false, marks: new Map([["bundle", 5]]) });
        expect(line).toBe("1970-01-01T00:00:00.000Z 0.1.111 manual bundle=+5 ready=- tray=- window=- painted=- shown=-");
        expect(line.split(" ").slice(3)).toHaveLength(STARTUP_STEPS.length);
    });
});

describe("the file", () => {
    it("keeps only the newest lines", () => {
        const old = Array.from({ length: STARTUP_LOG_LINES + 50 }, (_, index) => `line ${index}`).join("\n");
        const lines = withLine(old, "newest").trimEnd().split("\n");
        expect(lines).toHaveLength(STARTUP_LOG_LINES);
        expect(lines.at(-1)).toBe("newest");
        expect(lines[0]).toBe(`line ${51}`);
    });

    it("ends in one newline and drops blank or Windows-ended lines' leftovers", () => {
        expect(withLine("a\r\n\r\nb\n", "c")).toBe("a\nb\nc\n");
        expect(withLine("", "first")).toBe("first\n");
    });

    it("is created with its folder, then appended to", async () => {
        const path = join(folder, "logs", "startup.log");
        await appendStartupLine(path, "one");
        await appendStartupLine(path, "two");
        expect(readFileSync(path, "utf8")).toBe("one\ntwo\n");
    });

    it("stays capped across starts", async () => {
        const path = join(folder, "startup.log");
        for (let index = 0; index < 5; index++) await appendStartupLine(path, `start ${index}`, 3);
        expect(readFileSync(path, "utf8")).toBe("start 2\nstart 3\nstart 4\n");
    });

    it("writes this start's line once, in its shape, and never throws", async () => {
        const path = join(folder, "startup.log");
        const { writeStartupLog } = await freshStart();
        await writeStartupLog(path, "0.1.111", true);
        await writeStartupLog(path, "0.1.111", true);
        const lines = readFileSync(path, "utf8").trimEnd().split("\n");
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(LINE);
        expect(lines[0]).toMatch(/ 0\.1\.111 login bundle=\+\d+ /);
    });

    it("never throws when the log cannot be written", async () => {
        const blocker = join(folder, "not-a-folder");
        writeFileSync(blocker, "");
        await expect(appendStartupLine(join(blocker, "startup.log"), "x")).rejects.toThrow();
        // The once-only writer swallows the same failure.
        const { writeStartupLog } = await freshStart();
        await expect(writeStartupLog(join(blocker, "startup.log"), "0.1.111", false)).resolves.toBeUndefined();
    });
});
