/**
 * The autoscaling decision: quick to add capacity, slow to take it away, never
 * outside the range, and still within the cooldown.
 */

import { describe, expect, it } from "vitest";
import {
    AUTOSCALE_COOLDOWN_MS,
    AUTOSCALE_DOWN_AFTER,
    AUTOSCALE_IDLE,
    AUTOSCALE_UP_AFTER,
    autoscaleSchema,
    autoscaleStep,
    parseAutoscale,
    type AutoscaleState
} from "./scaling.js";

const config = { min: 1, max: 4, cpuPercent: 50 };
const NOW = Date.parse("2026-09-10T12:00:00Z");

/** Feed the same reading `times` times, a minute apart. */
function feed(replicas: number, cpu: number, times: number, state: AutoscaleState = AUTOSCALE_IDLE) {
    let current = { replicas, state };
    for (let tick = 0; tick < times; tick++) {
        current = autoscaleStep(config, current.replicas, cpu, current.state, NOW + tick * 60_000);
    }
    return current;
}

describe("autoscaleStep", () => {
    it("adds capacity only after the load has stayed high", () => {
        expect(feed(1, 80, AUTOSCALE_UP_AFTER - 1).replicas).toBe(1);
        expect(feed(1, 80, AUTOSCALE_UP_AFTER).replicas).toBe(2);
    });

    it("adds as many replicas as the reading needs, never past the most", () => {
        expect(feed(1, 150, AUTOSCALE_UP_AFTER).replicas).toBe(3);
        expect(feed(2, 400, AUTOSCALE_UP_AFTER).replicas).toBe(4);
        expect(feed(4, 99, AUTOSCALE_UP_AFTER * 3).replicas).toBe(4);
    });

    it("takes one away after a long quiet stretch, never below the fewest", () => {
        expect(feed(3, 10, AUTOSCALE_DOWN_AFTER - 1).replicas).toBe(3);
        expect(feed(3, 10, AUTOSCALE_DOWN_AFTER).replicas).toBe(2);
        expect(feed(1, 0, AUTOSCALE_DOWN_AFTER * 2).replicas).toBe(1);
    });

    it("leaves the count alone within the cooldown", () => {
        const justChanged = { above: 0, below: 0, changedAt: NOW };
        const result = feed(2, 60, AUTOSCALE_UP_AFTER, justChanged);
        expect(result.replicas).toBe(2);
        const later = autoscaleStep(config, 2, 60, result.state, NOW + AUTOSCALE_COOLDOWN_MS);
        expect(later.replicas).toBe(3);
    });

    it("brings a count outside the range back into it at once", () => {
        expect(autoscaleStep(config, 7, 10, AUTOSCALE_IDLE, NOW).replicas).toBe(4);
        expect(autoscaleStep({ ...config, min: 2 }, 1, 10, AUTOSCALE_IDLE, NOW).replicas).toBe(2);
    });

    it("decides nothing on a missing reading, and starts the streak over", () => {
        const primed = feed(1, 80, AUTOSCALE_UP_AFTER - 1);
        const gap = autoscaleStep(config, 1, null, primed.state, NOW);
        expect(gap.replicas).toBe(1);
        expect(gap.state.above).toBe(0);
    });

    it("does not count a middling reading toward either direction", () => {
        const result = feed(2, 40, AUTOSCALE_DOWN_AFTER * 2);
        expect(result.replicas).toBe(2);
    });
});

describe("the autoscale setting", () => {
    it("refuses a range whose most is below its fewest", () => {
        expect(autoscaleSchema.safeParse({ min: 3, max: 2, cpuPercent: 50 }).success).toBe(false);
    });

    it("reads a stored value that no longer validates as unset", () => {
        expect(parseAutoscale('{"min":1,"max":2,"cpuPercent":50}')).toEqual({ min: 1, max: 2, cpuPercent: 50 });
        expect(parseAutoscale('{"min":0}')).toBeNull();
        expect(parseAutoscale("nope")).toBeNull();
        expect(parseAutoscale(null)).toBeNull();
    });
});
