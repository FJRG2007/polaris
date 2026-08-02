import { describe, expect, it } from "vitest";
import { hasNewArrival } from "@/lib/notification-sound";

/** A feed snapshot as the stream sends it, cut down to what the chime looks at. */
function row(id: string, read = false) {
    return { id, read };
}

describe("hasNewArrival", () => {
    it("stays quiet for the snapshot the page opened with", () => {
        const seen = new Set(["a", "b"]);
        expect(hasNewArrival(seen, [row("a"), row("b")])).toBe(false);
    });

    it("fires once for an alert this tab has not shown", () => {
        const seen = new Set(["a"]);
        expect(hasNewArrival(seen, [row("b"), row("a")])).toBe(true);
        // The same frame again is not a second arrival.
        expect(hasNewArrival(seen, [row("b"), row("a")])).toBe(false);
    });

    it("stays quiet for an alert that arrived already read", () => {
        const seen = new Set<string>();
        expect(hasNewArrival(seen, [row("a", true)])).toBe(false);
        expect(seen.has("a")).toBe(true);
    });

    it("does not repeat when an alert is read or removed elsewhere", () => {
        const seen = new Set<string>();
        expect(hasNewArrival(seen, [row("a")])).toBe(true);
        expect(hasNewArrival(seen, [row("a", true)])).toBe(false);
        expect(hasNewArrival(seen, [])).toBe(false);
    });
});
