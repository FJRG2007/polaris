/**
 * Reading the edge's log without reading the edge's log.
 *
 * The bug this exists to keep out was silent by construction: the old reader
 * pulled the whole file into a string and sliced it, which stops working
 * entirely past Node's maximum string length. Every caller caught the error and
 * carried on with an empty window, so the firewall banned nobody and analytics
 * counted nothing while looking perfectly healthy.
 *
 * A half-gigabyte fixture is not something to write in a test suite, so what is
 * asserted here is the property that makes the size irrelevant: the read is
 * bounded by the window, at the end of the file, whatever the file is.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { readEdgeLogTail, trimEdgeLog } from "@/lib/edge-access-log";

/** One log line of a known size, so a fixture's shape is arithmetic rather than
 *  a guess. */
function line(index: number): string {
    // Quoted: JSON has no leading zeros, and a fixture that is not valid JSON
    // would fail the assertions below for its own reasons.
    return `{"n":"${String(index).padStart(8, "0")}"}`;
}

async function fixture(lines: number): Promise<{ dir: string; path: string }> {
    const dir = await mkdtemp(join(tmpdir(), "polaris-edge-log-"));
    const path = join(dir, "access.log");
    await writeFile(path, Array.from({ length: lines }, (_, i) => line(i)).join("\n") + "\n");
    return { dir, path };
}

/** The module reads the path on every call, so pointing it at a fixture is one
 *  assignment rather than a fresh import. */
function pointAt(path: string): void {
    process.env.POLARIS_TRAEFIK_ACCESSLOG = path;
}

const held = process.env.POLARIS_TRAEFIK_ACCESSLOG;

beforeEach(() => {
    delete process.env.POLARIS_TRAEFIK_ACCESSLOG;
});

afterEach(() => {
    if (held === undefined) delete process.env.POLARIS_TRAEFIK_ACCESSLOG;
    else process.env.POLARIS_TRAEFIK_ACCESSLOG = held;
});

describe("reading the tail", () => {
    it("reads the whole file when it is smaller than the window", async () => {
        const { path } = await fixture(10);
        pointAt(path);
        const text: string = await readEdgeLogTail(1024 * 1024);
        expect(text.trim().split("\n")).toHaveLength(10);
        expect(text).toContain(line(0));
    });

    it("reads only the end of a file bigger than the window", async () => {
        const { path } = await fixture(1000);
        pointAt(path);
        // Room for a handful of lines, not for a thousand.
        const text: string = await readEdgeLogTail(200);
        expect(text.length).toBeLessThanOrEqual(200);
        expect(text).toContain(line(999));
        expect(text).not.toContain(line(0));
    });

    it("never hands the parser half a line", async () => {
        const { path } = await fixture(1000);
        pointAt(path);
        const text: string = await readEdgeLogTail(207);
        for (const one of text.split("\n").filter(Boolean)) {
            expect(() => JSON.parse(one)).not.toThrow();
        }
    });

    it("is empty rather than an error when there is no log at all", async () => {
        pointAt(join(tmpdir(), "polaris-no-such-log", "access.log"));
        expect(await readEdgeLogTail(1024)).toBe("");
    });
});

describe("keeping it off the disk", () => {
    it("does nothing to a log under the cap", async () => {
        const { path } = await fixture(100);
        pointAt(path);
        const before = (await stat(path)).size;
        expect(await trimEdgeLog(1024 * 1024)).toBe(0);
        expect((await stat(path)).size).toBe(before);
    });

    it("keeps the newest lines and drops the rest, in the same file", async () => {
        const { path } = await fixture(5000);
        pointAt(path);
        const before = (await stat(path)).size;
        // A cap under the fixture, keeping much less than it holds.
        const freed: number = await trimEdgeLog(1024);
        expect(freed).toBeGreaterThan(0);

        const after = await readFile(path, "utf8");
        expect(after.length).toBeLessThan(before);
        expect(after).toContain(line(4999));
        expect(after).not.toContain(line(0));
        // Whole lines only: what is left has to be parseable from its first byte.
        for (const one of after.split("\n").filter(Boolean)) {
            expect(() => JSON.parse(one)).not.toThrow();
        }
    });

    it("says nothing was reclaimed when there is no log to trim", async () => {
        pointAt(join(tmpdir(), "polaris-no-such-log", "access.log"));
        expect(await trimEdgeLog(1)).toBe(0);
    });
});
