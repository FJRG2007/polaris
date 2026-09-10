/**
 * A followed log shows every line once, in time order, across replicas.
 *
 * The follow restarts from a tail after every pause, dropped connection and
 * deploy, so the first thing each reopened stream sends is output already on
 * screen. And replicas are followed separately, so their batches cross.
 */

import { describe, expect, it } from "vitest";
import { formatStreamLog, mergeStreamLines, type StreamLine } from "@/lib/deploy/log-stream";

const SERVICE = "0192f6a0-0000-7000-8000-000000000001";

function line(container: string, second: number, text: string): StreamLine {
    return {
        serviceId: SERVICE,
        container,
        stamp: `2026-09-10T10:00:${String(second).padStart(2, "0")}.000000000Z`,
        text
    };
}

describe("merging followed output", () => {
    it("drops what a reopened follow sends again", () => {
        const seen = new Map<string, string>();
        const first = mergeStreamLines([], [line("web-1", 1, "a"), line("web-1", 2, "b")], seen);
        // Reopened after a pause: the tail repeats "a" and "b", then carries on.
        const again = mergeStreamLines(
            first,
            [line("web-1", 1, "a"), line("web-1", 2, "b"), line("web-1", 3, "c")],
            seen
        );
        expect(again.map((entry) => entry.text)).toEqual(["a", "b", "c"]);
    });

    it("keeps each replica's own place, so one does not hide the other", () => {
        const seen = new Map<string, string>();
        const first = mergeStreamLines([], [line("web-1", 5, "one late")], seen);
        // web-2's first batch is older than what web-1 already showed.
        const merged = mergeStreamLines(
            first,
            [line("web-2", 3, "two early"), line("web-2", 6, "two later")],
            seen
        );
        expect(merged.map((entry) => entry.text)).toEqual(["two early", "one late", "two later"]);
    });

    it("orders a batch that arrived out of order", () => {
        const merged = mergeStreamLines(
            [],
            [line("web-2", 4, "second"), line("web-1", 2, "first")],
            new Map()
        );
        expect(merged.map((entry) => entry.text)).toEqual(["first", "second"]);
    });

    it("holds the list to its cap, keeping the newest", () => {
        const seen = new Map<string, string>();
        const batch = Array.from({ length: 10 }, (_, index) => line("web-1", index, `n${index}`));
        expect(mergeStreamLines([], batch, seen, 4).map((entry) => entry.text)).toEqual([
            "n6",
            "n7",
            "n8",
            "n9"
        ]);
    });

    it("keeps unstamped output beside the line it came after", () => {
        const merged = mergeStreamLines(
            [line("web-1", 5, "late")],
            [
                line("web-1", 6, "after"),
                { serviceId: SERVICE, container: "web-2", stamp: null, text: "bare" },
                line("web-2", 1, "early")
            ],
            new Map()
        );
        expect(merged.map((entry) => entry.text)).toEqual(["early", "late", "after", "bare"]);
    });
});

describe("the text the viewer reads", () => {
    it("names the container only when more than one is on screen", () => {
        const lines = [line("web-1", 1, "hello")];
        expect(formatStreamLog(lines, false)).toBe("2026-09-10T10:00:01.000000000Z hello");
        expect(formatStreamLog(lines, true)).toBe("2026-09-10T10:00:01.000000000Z [web-1] hello");
    });
});
