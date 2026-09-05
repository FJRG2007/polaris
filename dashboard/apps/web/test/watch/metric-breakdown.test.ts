/**
 * The arithmetic behind "what is using this".
 *
 * A metric card opens into a ranked list of what is behind it, and everything
 * that can quietly lie on that screen is here. A part that reads as 103% of the
 * whole, a leftover row holding the disagreement between two readings, a
 * bandwidth figure invented from a single counter reading - none of those look
 * wrong, which is exactly why they are worth pinning down.
 *
 * The three rules being asserted: nothing at zero is listed, a whole is never
 * smaller than its parts, and a counter read once has no rate.
 */

import { describe, expect, it } from "vitest";
import { counterAdvance } from "@/lib/metrics-shared";
import {
    nothingToShow,
    ranked,
    ratePerSecond,
    remainder,
    wholeOf,
    type BreakdownPart
} from "@/lib/watch/breakdown-shape";

function part(key: string, value: number): BreakdownPart {
    return { key, label: key, kind: "container", detail: null, value, href: null };
}

describe("ranking what is using a metric", () => {
    it("puts the heaviest first", () => {
        const rows = ranked([part("small", 1), part("big", 10), part("middle", 4)], null);
        expect(rows.map((row) => row.key)).toEqual(["big", "middle", "small"]);
    });

    it("leaves out anything using none of it", () => {
        const rows = ranked([part("idle", 0), part("busy", 3), part("broken", Number.NaN)], null);
        expect(rows.map((row) => row.key)).toEqual(["busy"]);
    });

    it("gives each row its share of the whole", () => {
        const rows = ranked([part("a", 3), part("b", 1)], 8);
        expect(rows[0]?.share).toBeCloseTo(0.375);
        expect(rows[1]?.share).toBeCloseTo(0.125);
    });

    it("never reports a part as more than the whole", () => {
        // The parts and the total are read moments apart, so a part measured just
        // after a total it is divided by can genuinely come out larger.
        const [row] = ranked([part("a", 12)], 10);
        expect(row?.share).toBe(1);
    });

    it("has no share to give when nothing measured the whole", () => {
        expect(ranked([part("a", 3)], null)[0]?.share).toBeNull();
    });
});

describe("the whole the shares are of", () => {
    it("is what measured it, when that is at least the parts", () => {
        expect(wholeOf(100, [part("a", 30), part("b", 20)])).toBe(100);
    });

    it("falls back to the parts when the measured total comes back smaller", () => {
        // A machine's own counter and the per-service counters under it are two
        // separate readings; taken a moment apart they can disagree, and the
        // parts are the half that was actually attributed.
        expect(wholeOf(40, [part("a", 30), part("b", 20)])).toBe(50);
    });

    it("is the parts when nothing measured the whole", () => {
        expect(wholeOf(null, [part("a", 30), part("b", 20)])).toBe(50);
    });

    it("is nothing at all when there is neither", () => {
        expect(wholeOf(null, [])).toBeNull();
        expect(wholeOf(0, [])).toBeNull();
    });
});

describe("what is left over", () => {
    const rest = { key: "rest", label: "Everything else", detail: "Not broken out." };

    it("is a row when the named things do not fill the whole", () => {
        const row = remainder(100, [part("a", 30), part("b", 20)], rest);
        expect(row?.value).toBe(50);
        expect(row?.kind).toBe("rest");
        // Nothing to open: it is the absence of the other rows, not a thing.
        expect(row?.href).toBeNull();
    });

    it("is not a row when the gap is the disagreement between two readings", () => {
        expect(remainder(100, [part("a", 99.5)], rest)).toBeNull();
    });

    it("is not a row when the parts fill the whole", () => {
        expect(remainder(100, [part("a", 60), part("b", 40)], rest)).toBeNull();
        expect(remainder(100, [part("a", 120)], rest)).toBeNull();
    });

    it("is not a row when there is no whole to be left over from", () => {
        expect(remainder(null, [part("a", 1)], rest)).toBeNull();
    });
});

describe("a counter turned into a rate", () => {
    it("is what moved, spread across the window", () => {
        expect(ratePerSecond(6_000n, 60_000)).toBe(100);
    });

    it("is nothing when the counter could not say how far it moved", () => {
        // One reading is a position, not a distance: a service sampled once inside
        // the window is left out rather than charted at zero.
        expect(ratePerSecond(counterAdvance([1_000n]), 60_000)).toBeNull();
        expect(ratePerSecond(null, 60_000)).toBeNull();
    });

    it("is nothing over a window with no time in it", () => {
        expect(ratePerSecond(6_000n, 0)).toBeNull();
    });

    it("reads a restarted counter as what it has counted since", () => {
        // The container began again mid-window. Its readings fall, and the fall is
        // never traffic that ran backwards.
        expect(ratePerSecond(counterAdvance([9_000n, 10_000n, 400n]), 1_000)).toBe(1_400);
    });
});

describe("a metric that cannot be taken apart", () => {
    it("carries the reason and nothing else", () => {
        const answer = nothingToShow("A service is one container.");
        expect(answer.rows).toHaveLength(0);
        expect(answer.total).toBeNull();
        expect(answer.unavailable).toBe("A service is one container.");
    });
});
