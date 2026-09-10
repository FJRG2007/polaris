/**
 * The autoscaling decision: quick to add capacity, slow to take it away, never
 * outside the range, and still within the cooldown - on CPU, on traffic, or on
 * both, with a setting from before traffic existed decided exactly as it was.
 */

import * as scaling from "./scaling.js";
import { describe, expect, it } from "vitest";

const {
    AUTOSCALE_COOLDOWN_MS,
    AUTOSCALE_DOWN_AFTER,
    AUTOSCALE_IDLE,
    AUTOSCALE_IDLE_AFTER,
    AUTOSCALE_UP_AFTER,
    autoscaleSchema,
    autoscaleStep,
    parseAutoscale,
    requestRate
} = scaling;

const config: scaling.Autoscale = { min: 1, max: 4, cpuPercent: 50, requestsPerCopy: null };
const withTraffic: scaling.Autoscale = { ...config, requestsPerCopy: 100 };
const NOW = Date.parse("2026-09-10T12:00:00Z");

/** Feed the same reading `times` times, a minute apart. */
function feed(
    replicas: number,
    reading: number | scaling.AutoscaleReading,
    times: number,
    state: scaling.AutoscaleState = AUTOSCALE_IDLE,
    setting: scaling.Autoscale = config
) {
    const each =
        typeof reading === "number" ? { cpuPercent: reading, requestsPerMinute: null } : reading;
    let current: ReturnType<typeof autoscaleStep> = { replicas, state, signal: null };
    const signals: scaling.AutoscaleSignal[] = [];
    for (let tick = 0; tick < times; tick++) {
        current = autoscaleStep(
            setting,
            current.replicas,
            each,
            current.state,
            NOW + tick * 60_000
        );
        if (current.signal) signals.push(current.signal);
    }
    return { ...current, signals };
}

/** The same, for a setting that holds each copy to 100 requests a minute. */
function feedTraffic(
    replicas: number,
    cpuPercent: number | null,
    requestsPerMinute: number | null,
    times: number,
    state: scaling.AutoscaleState = AUTOSCALE_IDLE,
    setting: scaling.Autoscale = withTraffic
) {
    return feed(replicas, { cpuPercent, requestsPerMinute }, times, state, setting);
}

const cpu = (cpuPercent: number | null) => ({ cpuPercent, requestsPerMinute: null });

describe("autoscaleStep on CPU", () => {
    it("adds capacity only after the load has stayed high", () => {
        expect(feed(1, 80, AUTOSCALE_UP_AFTER - 1).replicas).toBe(1);
        expect(feed(1, 80, AUTOSCALE_UP_AFTER).replicas).toBe(2);
        expect(feed(1, 80, AUTOSCALE_UP_AFTER).signals).toEqual(["cpu"]);
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
        const justChanged = { above: 0, below: 0, quiet: 0, changedAt: NOW };
        const result = feed(2, 60, AUTOSCALE_UP_AFTER, justChanged);
        expect(result.replicas).toBe(2);
        const later = autoscaleStep(config, 2, cpu(60), result.state, NOW + AUTOSCALE_COOLDOWN_MS);
        expect(later.replicas).toBe(3);
    });

    it("brings a count outside the range back into it at once", () => {
        expect(autoscaleStep(config, 7, cpu(10), AUTOSCALE_IDLE, NOW)).toMatchObject({
            replicas: 4,
            signal: "range"
        });
        expect(autoscaleStep({ ...config, min: 2 }, 1, cpu(10), AUTOSCALE_IDLE, NOW).replicas).toBe(
            2
        );
    });

    it("decides nothing on a missing reading, and starts the streak over", () => {
        const primed = feed(1, 80, AUTOSCALE_UP_AFTER - 1);
        const gap = autoscaleStep(config, 1, cpu(null), primed.state, NOW);
        expect(gap.replicas).toBe(1);
        expect(gap.signal).toBeNull();
        expect(gap.state.above).toBe(0);
    });

    it("does not count a middling reading toward either direction", () => {
        const result = feed(2, 40, AUTOSCALE_DOWN_AFTER * 2);
        expect(result.replicas).toBe(2);
    });
});

describe("autoscaleStep on traffic", () => {
    it("adds copies on traffic alone, as many as the requests need", () => {
        // 450 a minute on one copy is 4.5 times a target of 100: five copies, at most four.
        expect(feedTraffic(1, 5, 450, AUTOSCALE_UP_AFTER)).toMatchObject({
            replicas: 4,
            signals: ["traffic"]
        });
        expect(feedTraffic(1, 5, 250, AUTOSCALE_UP_AFTER).replicas).toBe(3);
    });

    it("judges requests per copy, not in total", () => {
        // 300 a minute over three copies is 100 each: on target, not over it.
        expect(feedTraffic(3, 30, 300, AUTOSCALE_UP_AFTER * 3).replicas).toBe(3);
    });

    it("says both signals moved it when both were over", () => {
        expect(feedTraffic(1, 80, 150, AUTOSCALE_UP_AFTER)).toMatchObject({
            replicas: 2,
            signals: ["both"]
        });
    });

    it("scales up when either signal is over, whatever the other says", () => {
        expect(feedTraffic(1, 80, 0, AUTOSCALE_UP_AFTER)).toMatchObject({
            replicas: 2,
            signals: ["cpu"]
        });
    });

    it("takes a copy away only when both signals are low", () => {
        // CPU is quiet but each copy still takes 60 a minute, over half of 100.
        expect(feedTraffic(3, 5, 180, AUTOSCALE_DOWN_AFTER * 2).replicas).toBe(3);
        // Traffic is quiet but CPU sits between half its target and the target.
        expect(feedTraffic(3, 40, 30, AUTOSCALE_DOWN_AFTER * 2).replicas).toBe(3);
        expect(feedTraffic(3, 5, 30, AUTOSCALE_DOWN_AFTER)).toMatchObject({
            replicas: 2,
            signals: ["both"]
        });
    });

    it("keeps the hysteresis: a reading between half and the target counts toward neither", () => {
        const middling = feedTraffic(2, 5, 150, AUTOSCALE_DOWN_AFTER * 2);
        expect(middling.replicas).toBe(2);
        expect(middling.state).toMatchObject({ above: 0, below: 0 });
    });

    it("starts the rising streak over when the traffic dips", () => {
        const primed = feedTraffic(1, 5, 500, AUTOSCALE_UP_AFTER - 1);
        const dip = autoscaleStep(
            withTraffic,
            1,
            { cpuPercent: 5, requestsPerMinute: 80 },
            primed.state,
            NOW
        );
        expect(dip.state.above).toBe(0);
        expect(feedTraffic(1, 5, 500, AUTOSCALE_UP_AFTER - 1, dip.state).replicas).toBe(1);
    });

    it("goes straight to the fewest after a stretch with no request at all", () => {
        expect(feedTraffic(4, 3, 0, AUTOSCALE_IDLE_AFTER)).toMatchObject({
            replicas: 1,
            signals: ["idle"]
        });
        const floor = feedTraffic(4, 3, 0, AUTOSCALE_IDLE_AFTER, AUTOSCALE_IDLE, {
            ...withTraffic,
            min: 2
        });
        expect(floor.replicas).toBe(2);
    });

    it("does not call it idle while the CPU is still working", () => {
        expect(feedTraffic(4, 40, 0, AUTOSCALE_IDLE_AFTER * 2).replicas).toBe(4);
    });

    it("steps down one copy, not to the fewest, when a single request broke the idle stretch", () => {
        const almost = feedTraffic(4, 3, 0, AUTOSCALE_IDLE_AFTER - 1);
        expect(almost.state.quiet).toBe(AUTOSCALE_IDLE_AFTER - 1);
        const one = autoscaleStep(
            withTraffic,
            4,
            { cpuPercent: 3, requestsPerMinute: 1 },
            almost.state,
            NOW
        );
        expect(one).toMatchObject({ replicas: 3, signal: "both" });
    });

    it("waits out the cooldown before going idle", () => {
        const primed = {
            above: 0,
            below: AUTOSCALE_IDLE_AFTER - 1,
            quiet: AUTOSCALE_IDLE_AFTER - 1,
            changedAt: NOW - 60_000
        };
        const idle = { cpuPercent: 3, requestsPerMinute: 0 };
        const cooling = autoscaleStep(withTraffic, 4, idle, primed, NOW);
        expect(cooling.replicas).toBe(4);
        const later = autoscaleStep(
            withTraffic,
            4,
            idle,
            cooling.state,
            NOW - 60_000 + AUTOSCALE_COOLDOWN_MS
        );
        expect(later).toMatchObject({ replicas: 1, signal: "idle" });
    });

    it("decides on CPU alone when the requests cannot be counted", () => {
        expect(feedTraffic(1, 80, null, AUTOSCALE_UP_AFTER)).toMatchObject({
            replicas: 2,
            signals: ["cpu"]
        });
        const down = feedTraffic(3, 5, null, AUTOSCALE_DOWN_AFTER);
        expect(down).toMatchObject({ replicas: 2, signals: ["cpu"] });
        expect(down.state.quiet).toBe(0);
    });

    it("decides on traffic alone when no copy reports its CPU", () => {
        expect(feedTraffic(1, null, 250, AUTOSCALE_UP_AFTER)).toMatchObject({
            replicas: 3,
            signals: ["traffic"]
        });
    });
});

describe("a setting from before traffic", () => {
    const old = parseAutoscale('{"min":1,"max":4,"cpuPercent":50}');
    const setting = (): scaling.Autoscale => {
        if (!old) throw new Error("the stored setting did not parse");
        return old;
    };

    it("reads back whole, with no traffic target", () => {
        expect(old).toEqual({ min: 1, max: 4, cpuPercent: 50, requestsPerCopy: null });
    });

    it("ignores traffic entirely, however busy or idle", () => {
        expect(
            feedTraffic(1, 40, 1_000_000, AUTOSCALE_UP_AFTER * 3, AUTOSCALE_IDLE, setting())
                .replicas
        ).toBe(1);
        const silent = feedTraffic(4, 40, 0, AUTOSCALE_IDLE_AFTER * 3, AUTOSCALE_IDLE, setting());
        expect(silent.replicas).toBe(4);
        expect(silent.state.quiet).toBe(0);
    });

    it("moves exactly as it did on CPU", () => {
        const up = feedTraffic(1, 150, 999, AUTOSCALE_UP_AFTER, AUTOSCALE_IDLE, setting());
        expect(up).toMatchObject({ replicas: 3, signals: ["cpu"] });
        const down = feedTraffic(3, 10, 999, AUTOSCALE_DOWN_AFTER, AUTOSCALE_IDLE, setting());
        expect(down).toMatchObject({ replicas: 2, signals: ["cpu"] });
    });
});

describe("requestRate", () => {
    const at = (secondsAgo: number) => NOW - secondsAgo * 1000;

    it("counts the requests of the last minute", () => {
        const times = [at(90), at(59), at(30), at(1)];
        expect(requestRate(times, at(600), NOW)).toBe(3);
    });

    it("scales a log that holds less than the minute up to one", () => {
        // The window reaches back 30 seconds: 10 requests in it is 20 a minute.
        const times = Array.from({ length: 10 }, (_, index) => at(index * 3));
        expect(requestRate(times, at(30), NOW)).toBe(20);
    });

    it("is zero for a service nobody reached in a log that covers the minute", () => {
        expect(requestRate([], at(600), NOW)).toBe(0);
    });

    it("does not know when the log holds nothing, or too little of the minute", () => {
        expect(requestRate([], null, NOW)).toBeNull();
        expect(requestRate([at(2)], at(3), NOW)).toBeNull();
    });

    it("reads a busy log cut short by the size read over the seconds it holds", () => {
        // Three seconds of log, cut at the byte cap: 6 requests in them is 120 a minute.
        const times = Array.from({ length: 6 }, (_, index) => at(index * 0.5));
        expect(requestRate(times, at(3), NOW, true)).toBe(120);
        expect(requestRate([], null, NOW, true)).toBeNull();
        expect(requestRate([NOW], NOW, NOW, true)).toBeNull();
    });
});

describe("the autoscale setting", () => {
    const range = { min: 1, max: 2, cpuPercent: 50 };

    it("refuses a range whose most is below its fewest", () => {
        expect(autoscaleSchema.safeParse({ min: 3, max: 2, cpuPercent: 50 }).success).toBe(false);
    });

    it("takes a traffic target, and none", () => {
        expect(autoscaleSchema.parse({ ...range, requestsPerCopy: 600 }).requestsPerCopy).toBe(600);
        expect(
            autoscaleSchema.parse({ ...range, requestsPerCopy: null }).requestsPerCopy
        ).toBeNull();
    });

    it("refuses a traffic target that is not a whole number of requests", () => {
        for (const requestsPerCopy of [0, -5, 1.5, scaling.REQUESTS_PER_COPY_MAX + 1, Number.NaN]) {
            expect(autoscaleSchema.safeParse({ ...range, requestsPerCopy }).success).toBe(false);
        }
    });

    it("reads a stored value that no longer validates as unset", () => {
        expect(parseAutoscale('{"min":1,"max":2,"cpuPercent":50,"requestsPerCopy":120}')).toEqual({
            ...range,
            requestsPerCopy: 120
        });
        expect(parseAutoscale('{"min":1,"max":2,"cpuPercent":50,"requestsPerCopy":0}')).toBeNull();
        expect(parseAutoscale('{"min":0}')).toBeNull();
        expect(parseAutoscale("nope")).toBeNull();
        expect(parseAutoscale(null)).toBeNull();
    });
});

describe("trafficRefusal", () => {
    it("counts requests only for a service on the machine Polaris runs on", () => {
        expect(scaling.trafficRefusal({ target: { kind: "local" } })).toBeNull();
        expect(scaling.trafficRefusal({ target: { kind: "host" } })).toMatch(/another server/);
    });
});
