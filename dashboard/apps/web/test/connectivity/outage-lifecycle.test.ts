/**
 * How a pass of the address watcher moves the outage record.
 *
 * The rules worth pinning are the ones a single pass cannot show: an outage is
 * one row however many passes see it, a restart in the middle of one continues
 * it rather than starting a second, a restart nobody was watching through is
 * closed at the last moment it was actually seen down rather than left open or
 * counted as downtime, and a line that drops again within the merge gap is the
 * same outage coming back.
 */

import { describe, expect, it } from "vitest";
import * as rules from "@/lib/connectivity/outages";

const MINUTE = 60_000;
const GAP = 60_000;
const STALE = 22 * MINUTE;
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

const lineDown: rules.Observation = {
    up: false,
    kind: "line",
    detectedBy: "polaris.example.com",
    detail: "Timed out"
};
const addressDown: rules.Observation = {
    up: false,
    kind: "address",
    detectedBy: "polaris.example.com",
    detail: "HTTP 502"
};
const up: rules.Observation = { up: true, via: "polaris.example.com" };

/** A tiny in-memory record the steps are applied to, the way the tracker writes them. */
function simulate() {
    let rows: (rules.OutageSnapshot & { blips: number })[] = [];
    let lastUpAt: number | null = null;
    let next = 1;
    const pass = (observation: rules.Observation, now: number) => {
        const open = rows.find((row) => row.endedAt === null) ?? null;
        const last =
            [...rows]
                .filter((row) => row.endedAt !== null)
                .sort((a, b) => b.endedAt! - a.endedAt!)[0] ?? null;
        const steps = rules.nextSteps({
            open,
            last,
            observation,
            now,
            mergeGapMs: GAP,
            staleMs: STALE,
            lastUpAt
        });
        for (const step of steps) {
            if (step.do === "open") {
                rows.push({
                    id: String(next++),
                    kind: step.kind,
                    startedAt: step.at,
                    endedAt: null,
                    lastSeenAt: step.at,
                    firstBack: null,
                    closedBy: null,
                    blips: 0
                });
            } else {
                rows = rows.map((row) => {
                    if (row.id !== step.id) return row;
                    if (step.do === "continue")
                        return {
                            ...row,
                            kind: step.kind,
                            lastSeenAt: step.at,
                            firstBack: step.firstBack
                        };
                    if (step.do === "close") {
                        return {
                            ...row,
                            endedAt: step.at,
                            closedBy: step.closedBy,
                            firstBack: step.firstBack
                        };
                    }
                    return {
                        ...row,
                        endedAt: null,
                        closedBy: null,
                        kind: step.kind,
                        lastSeenAt: step.at,
                        firstBack: null,
                        blips: row.blips + 1
                    };
                });
            }
        }
        if (observation.up) lastUpAt = now;
        return steps;
    };
    return { pass, rows: () => rows };
}

describe("an outage's life", () => {
    it("opens once, continues on every pass that still finds it, and closes on the first that does not", () => {
        const record = simulate();
        record.pass(up, T0);
        record.pass(lineDown, T0 + MINUTE);
        record.pass(lineDown, T0 + 2 * MINUTE);
        record.pass(lineDown, T0 + 3 * MINUTE);
        record.pass(up, T0 + 4 * MINUTE);

        expect(record.rows()).toHaveLength(1);
        const [outage] = record.rows();
        expect(outage).toMatchObject({
            kind: "line",
            startedAt: T0 + MINUTE,
            endedAt: T0 + 4 * MINUTE,
            closedBy: "recovered",
            firstBack: "polaris.example.com"
        });
    });

    it("keeps the worst kind it went through", () => {
        const record = simulate();
        record.pass(addressDown, T0);
        record.pass(lineDown, T0 + MINUTE);
        record.pass(addressDown, T0 + 2 * MINUTE);
        expect(record.rows()[0]?.kind).toBe("line");
    });

    it("notes the internet coming back before the address does", () => {
        const record = simulate();
        record.pass(lineDown, T0);
        record.pass(addressDown, T0 + MINUTE);
        record.pass(up, T0 + 5 * MINUTE);
        expect(record.rows()[0]?.firstBack).toBe(rules.BACK_VIA_INTERNET);
    });

    it("hands the open start the last moment everything answered, so the start's precision is known", () => {
        const steps = rules.nextSteps({
            open: null,
            last: null,
            observation: lineDown,
            now: T0 + 10 * MINUTE,
            mergeGapMs: GAP,
            staleMs: STALE,
            lastUpAt: T0
        });
        expect(steps).toEqual([
            expect.objectContaining({
                do: "open",
                at: T0 + 10 * MINUTE,
                lastUpAt: T0,
                detectedBy: "polaris.example.com"
            })
        ]);
    });
});

describe("Polaris restarting during an outage", () => {
    it("continues the same outage when the next pass comes soon after the last", () => {
        const record = simulate();
        record.pass(lineDown, T0);
        // A redeploy: a few minutes with no pass, then the new process sees it still down.
        record.pass(lineDown, T0 + 6 * MINUTE);
        record.pass(up, T0 + 7 * MINUTE);
        expect(record.rows()).toHaveLength(1);
        expect(record.rows()[0]?.endedAt).toBe(T0 + 7 * MINUTE);
    });

    it("closes an outage nobody watched at its last sighting, never counting the unwatched time", () => {
        const record = simulate();
        record.pass(lineDown, T0);
        record.pass(lineDown, T0 + MINUTE);
        // Polaris was off for three hours and comes back to a working line.
        record.pass(up, T0 + 3 * 60 * MINUTE);
        expect(record.rows()).toHaveLength(1);
        expect(record.rows()[0]).toMatchObject({ endedAt: T0 + MINUTE, closedBy: "unobserved" });
    });

    it("starts a second outage when the line is still down after an unwatched gap", () => {
        const record = simulate();
        record.pass(lineDown, T0);
        const steps = record.pass(lineDown, T0 + 3 * 60 * MINUTE);
        expect(steps.map((step) => step.do)).toEqual(["close", "open"]);
        expect(record.rows()).toHaveLength(2);
        expect(record.rows().filter((row) => row.endedAt === null)).toHaveLength(1);
    });

    it("does not merge a fresh outage into one that was closed as unwatched", () => {
        const record = simulate();
        record.pass(lineDown, T0);
        record.pass(up, T0 + 3 * 60 * MINUTE);
        record.pass(lineDown, T0 + 3 * 60 * MINUTE + 10_000);
        expect(record.rows()).toHaveLength(2);
    });
});

describe("flapping", () => {
    it("folds a drop within the merge gap of a recovery into the same outage, and counts the blip", () => {
        const record = simulate();
        record.pass(lineDown, T0);
        record.pass(up, T0 + 30_000);
        record.pass(lineDown, T0 + 60_000);
        record.pass(up, T0 + 90_000);
        expect(record.rows()).toHaveLength(1);
        expect(record.rows()[0]).toMatchObject({ startedAt: T0, endedAt: T0 + 90_000, blips: 1 });
    });

    it("counts a drop past the gap as a new outage", () => {
        const record = simulate();
        record.pass(lineDown, T0);
        record.pass(up, T0 + 30_000);
        record.pass(lineDown, T0 + 30_000 + GAP + 1);
        expect(record.rows()).toHaveLength(2);
    });

    it("merges nothing when the gap is zero", () => {
        const steps = rules.nextSteps({
            open: null,
            last: {
                id: "1",
                kind: "line",
                startedAt: T0,
                endedAt: T0 + 1000,
                lastSeenAt: T0,
                firstBack: null,
                closedBy: "recovered"
            },
            observation: lineDown,
            now: T0 + 2000,
            mergeGapMs: 0,
            staleMs: STALE,
            lastUpAt: null
        });
        expect(steps[0]?.do).toBe("open");
    });

    it("keeps watching closely through the merge window, then relaxes", () => {
        const last = { endedAt: T0, closedBy: "recovered" };
        expect(rules.watchClosely(null, last, T0 + 10_000, GAP)).toBe(true);
        expect(rules.watchClosely(null, last, T0 + GAP + 1, GAP)).toBe(false);
        expect(rules.watchClosely({ endedAt: null }, null, T0, GAP)).toBe(true);
    });
});

describe("one pass, one verdict", () => {
    const probe = (host: string, isUp: boolean, code: string | null = null): rules.ProbeResult => ({
        host,
        up: isUp,
        detail: isUp ? null : "fetch failed",
        code
    });

    it("is up when any address answered, whatever the others did", () => {
        expect(
            rules.observe([probe("a.example.com", false), probe("b.example.com", true)], null)
        ).toEqual({
            up: true,
            via: "b.example.com"
        });
    });

    it("is the line when the resolvers are silent too", () => {
        expect(rules.observe([probe("a.example.com", false)], false)).toMatchObject({
            up: false,
            kind: "line"
        });
    });

    it("is DNS when every failure was a name that did not resolve", () => {
        expect(rules.observe([probe("a.example.com", false, "ENOTFOUND")], true)).toMatchObject({
            up: false,
            kind: "dns",
            detail: "ENOTFOUND"
        });
    });

    it("is the address when the line works and nothing answered there", () => {
        expect(rules.observe([probe("a.example.com", false, "ECONNREFUSED")], true)).toMatchObject({
            up: false,
            kind: "address"
        });
    });

    it("with no public address, asks only whether the line is up", () => {
        expect(rules.observe([], false)).toMatchObject({
            up: false,
            kind: "line",
            detectedBy: null
        });
        expect(rules.observe([], true)).toEqual({ up: true, via: rules.BACK_VIA_INTERNET });
        expect(rules.observe([], null)).toBeNull();
    });

    it("gives no verdict when addresses were listed but none produced a result", () => {
        expect(rules.observe([], true, 2)).toBeNull();
        expect(rules.observe([], false, 2)).toMatchObject({
            up: false,
            kind: "line",
            detectedBy: null
        });
    });
});
