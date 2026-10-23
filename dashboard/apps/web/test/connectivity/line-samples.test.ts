/**
 * The line's samples: what one says, how a run of them becomes down and up (one
 * lost sample is not an outage), the address change and "unreachable from
 * outside" events, the payloads automations receive, and the chart buckets.
 */

import { describe, expect, it } from "vitest";
import * as rules from "../../src/lib/connectivity/line-samples";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 23, 10, 0, 0);

function probe(overrides: Partial<rules.LineProbe> = {}): rules.LineProbe {
    return {
        attempts: 6,
        latencies: [12, 14, 13, 15, 12, 20],
        dnsOk: true,
        dnsMs: 8,
        publicIp: null,
        outside: null,
        ...overrides
    };
}

const DEAD = probe({ latencies: [], dnsOk: false, dnsMs: null });
const DNS_ONLY = probe({ dnsOk: false, dnsMs: null });

function run(probes: readonly rules.LineProbe[], start = rules.INITIAL_LINE_STATE) {
    let state = start;
    const events: rules.ConnectivityEvent[] = [];
    probes.forEach((one, index) => {
        const step = rules.advanceLine(state, one, T0 + index * MIN);
        state = step.state;
        events.push(...step.events);
    });
    return { state, events };
}

describe("one sample", () => {
    it("tells a dead line from a dead resolver", () => {
        expect(rules.verdict(probe())).toBe("up");
        expect(rules.verdict(DEAD)).toBe("line");
        expect(rules.verdict(DNS_ONLY)).toBe("dns");
    });

    it("measures loss and the median connect time", () => {
        expect(rules.lossPercent(probe({ latencies: [10, 20, 30] }))).toBe(50);
        expect(rules.lossPercent(DEAD)).toBe(100);
        expect(rules.median([30, 10, 20])).toBe(20);
        expect(rules.median([10, 20])).toBe(15);
        expect(rules.median([])).toBeNull();
    });
});

describe("down and up", () => {
    it("does not open an outage for one lost sample", () => {
        const { state, events } = run([probe(), DEAD, probe()]);
        expect(events).toEqual([]);
        expect(state.status).toBe("up");
        expect(state.failStreak).toBe(0);
    });

    it("goes down after two failed samples, dated at the first", () => {
        const { state, events } = run([probe(), DEAD, DEAD, DEAD]);
        expect(events).toEqual([
            { event: "down", kind: "line", since: new Date(T0 + MIN).toISOString() }
        ]);
        expect(state.status).toBe("down");
    });

    it("says DNS only when the line answered and the name did not", () => {
        const { events } = run([DNS_ONLY, DNS_ONLY]);
        expect(events).toEqual([{ event: "down", kind: "dns", since: new Date(T0).toISOString() }]);
    });

    it("keeps the worst kind an outage went through", () => {
        const { events } = run([DNS_ONLY, DNS_ONLY, DEAD, probe()]);
        expect(events.map((event) => event.event)).toEqual(["down", "up"]);
        expect(events[1]).toMatchObject({ event: "up", kind: "line" });
    });

    it("comes back on the first good sample, with how long it lasted", () => {
        const { events } = run([DEAD, DEAD, DEAD, probe()]);
        const back = events.find((event) => event.event === "up");
        expect(back).toEqual({
            event: "up",
            kind: "line",
            since: new Date(T0).toISOString(),
            at: new Date(T0 + 3 * MIN).toISOString(),
            durationSeconds: 180
        });
        expect(rules.connectivityPayloadSchemas.up.safeParse(back).success).toBe(true);
    });

    it("announces each transition once however long it lasts", () => {
        const { events } = run([DEAD, DEAD, DEAD, DEAD, DEAD, probe(), probe(), probe()]);
        expect(events.map((event) => event.event)).toEqual(["down", "up"]);
    });
});

describe("the public address", () => {
    it("is not a change the first time it is seen", () => {
        const { events, state } = run([probe({ publicIp: "203.0.113.5" })]);
        expect(events).toEqual([]);
        expect(state.publicIp).toBe("203.0.113.5");
    });

    it("reports a change with the old and the new address", () => {
        const { events } = run([
            probe({ publicIp: "203.0.113.5" }),
            probe(),
            probe({ publicIp: "198.51.100.7" })
        ]);
        expect(events).toEqual([
            {
                event: "ipChanged",
                previous: "203.0.113.5",
                current: "198.51.100.7",
                at: new Date(T0 + 2 * MIN).toISOString()
            }
        ]);
        expect(rules.connectivityPayloadSchemas.ipChanged.safeParse(events[0]).success).toBe(true);
    });

    it("says unreachable from outside once, and only for a name that pointed here", () => {
        const never = run([probe({ outside: false }), probe({ outside: false })]);
        expect(never.events).toEqual([]);

        const { events } = run([
            probe({ publicIp: "203.0.113.5", outside: true }),
            probe({ outside: false }),
            probe({ outside: false }),
            probe({ outside: true }),
            probe({ outside: false })
        ]);
        const said = events.filter((event) => event.event === "unreachable");
        expect(said).toHaveLength(2);
        expect(said[0]).toMatchObject({ publicIp: "203.0.113.5" });
        expect(rules.connectivityPayloadSchemas.unreachable.safeParse(said[0]).success).toBe(true);
    });
});

describe("stored state", () => {
    it("reads back what it wrote and falls back on anything else", () => {
        const { state } = run([DEAD, DEAD]);
        expect(rules.parseLineState(JSON.stringify(state))).toEqual(state);
        expect(rules.parseLineState("{oops")).toEqual(rules.INITIAL_LINE_STATE);
        expect(rules.parseLineState(JSON.stringify({ status: "sideways" }))).toEqual(
            rules.INITIAL_LINE_STATE
        );
        expect(rules.parseLineState(null)).toEqual(rules.INITIAL_LINE_STATE);
    });
});

describe("charts", () => {
    it("buckets samples into steps and leaves gaps where nothing was measured", () => {
        const to = T0;
        const sums = [
            {
                at: to - 5 * MIN,
                sum: rules.sumOfSample({ up: true, dnsOk: true, latencyMs: 10, lossPct: 0 })
            },
            {
                at: to - 4 * MIN,
                sum: rules.sumOfSample({ up: true, dnsOk: true, latencyMs: 30, lossPct: 50 })
            },
            {
                at: to - 3 * MIN,
                sum: rules.sumOfSample({ up: false, dnsOk: false, latencyMs: null, lossPct: 100 })
            },
            {
                at: to - 2 * MIN,
                sum: rules.sumOfSample({ up: true, dnsOk: false, latencyMs: 20, lossPct: 0 })
            }
        ];
        const points = rules.lineSeries(sums, "24h", to);
        expect(points).toHaveLength(144);
        const last = points.at(-1)!;
        expect(last.latencyMs).toBe(20);
        expect(last.lossPct).toBe(37.5);
        expect(last.upPct).toBe(50);
        expect(points[0]).toEqual({ t: points[0]!.t, latencyMs: null, lossPct: null, upPct: null });

        const totals = rules.lineTotals(sums);
        expect(totals.samples).toBe(4);
        expect(totals.latencyMaxMs).toBe(30);
    });

    it("has a step for every range that divides it evenly", () => {
        for (const range of rules.LINE_RANGES) {
            const { spanMs, stepMs } = rules.RANGE_SPEC[range];
            expect(spanMs % stepMs).toBe(0);
            expect(rules.lineSeries([], range, T0).length).toBeLessThanOrEqual(200);
        }
    });
});
