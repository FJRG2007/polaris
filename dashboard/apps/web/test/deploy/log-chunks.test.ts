/**
 * Container output becomes whole, ordered lines, and none is kept twice.
 *
 * The three ways this goes wrong quietly: a line split across two chunks printed
 * as two lines, replicas' lines interleaved by arrival instead of by time, and a
 * capture that re-stores the lines it already has on every pass.
 */

import { describe, expect, it } from "vitest";
import { LineSplitter, linesAfter, normalizeStamp, splitStamp, stampDate } from "@/lib/deploy/log-chunks";

describe("splitting chunks into lines", () => {
    it("holds a partial line until the rest of it arrives", () => {
        const splitter = new LineSplitter();
        expect(splitter.push("2026-09-10T10:00:00.1Z first\n2026-09-10T10:00")).toEqual([
            "2026-09-10T10:00:00.1Z first"
        ]);
        expect(splitter.push(":01.2Z second\n")).toEqual(["2026-09-10T10:00:01.2Z second"]);
        expect(splitter.flush()).toEqual([]);
    });

    it("keeps a character whole when the pipe splits its bytes", () => {
        const splitter = new LineSplitter();
        const word = `caf${String.fromCharCode(0xe9)}`;
        const bytes = Buffer.from(`${word}\n`, "utf8");
        // The accent is two bytes; cut between them.
        expect(splitter.push(bytes.subarray(0, 4))).toEqual([]);
        expect(splitter.push(bytes.subarray(4))).toEqual([word]);
    });

    it("hands back what was held when the stream ends", () => {
        const splitter = new LineSplitter();
        splitter.push("no newline at the end");
        expect(splitter.flush()).toEqual(["no newline at the end"]);
    });
});

describe("reading the stamp", () => {
    it("pads the fraction so text order is time order", () => {
        expect(normalizeStamp("2026-09-10T10:00:00.5Z")).toBe("2026-09-10T10:00:00.500000000Z");
        expect(normalizeStamp("2026-09-10T10:00:00Z")).toBe("2026-09-10T10:00:00.000000000Z");
        // Without padding ".5" sorts after ".123456789" as text and before it as time.
        expect(normalizeStamp("2026-09-10T10:00:00.5Z") > normalizeStamp("2026-09-10T10:00:00.123456789Z")).toBe(true);
    });

    it("keeps the message and drops a carriage return", () => {
        expect(splitStamp("2026-09-10T10:00:00.123456789Z listening on :3000\r")).toEqual({
            stamp: "2026-09-10T10:00:00.123456789Z",
            text: "listening on :3000"
        });
        expect(splitStamp("plain output")).toEqual({ stamp: null, text: "plain output" });
        // A NUL byte would fail the whole insert, every capture, until it left the tail.
        expect(splitStamp(`a${String.fromCharCode(0)}b`).text).toBe("ab");
        expect(stampDate("2026-09-10T10:00:00.123456789Z").toISOString()).toBe("2026-09-10T10:00:00.123Z");
    });
});

describe("keeping only what is new", () => {
    it("takes the lines strictly after the last one kept, in order", () => {
        const lines = [
            splitStamp("2026-09-10T10:00:03Z c"),
            splitStamp("2026-09-10T10:00:01Z a"),
            splitStamp("2026-09-10T10:00:02Z b"),
            splitStamp("no stamp")
        ];
        const after = normalizeStamp("2026-09-10T10:00:01Z");
        expect(linesAfter(lines, after).map((line) => line.text)).toEqual(["b", "c"]);
        expect(linesAfter(lines, null).map((line) => line.text)).toEqual(["a", "b", "c"]);
    });
});
