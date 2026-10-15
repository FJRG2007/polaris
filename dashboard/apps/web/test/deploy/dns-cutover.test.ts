/**
 * The DNS cutover's state machine: where a cutover starts, each pass of the
 * background job, what Switch, Finish and Rollback do from every phase, and that
 * running any of them twice changes nothing the second time.
 */

import { describe, expect, it } from "vitest";
import * as cutover from "@/lib/deploy/dns-cutover";

const NOW = new Date("2026-10-16T12:00:00.000Z");
const HEALTHY: cutover.PreflightChecks = {
    deployed: true,
    running: true,
    answers: "up",
    code: 200,
    newValue: "203.0.113.7",
    tls: "on-switch"
};

function row(overrides: Partial<cutover.CutoverRow> = {}): cutover.CutoverRow {
    return {
        phase: "ready",
        mode: "cloudflare",
        lowerUntil: null,
        switchedAt: null,
        oldTtl: 3600,
        ...overrides
    };
}

describe("the pre-flight", () => {
    it("passes a deployed, running target that answers for the name", () => {
        expect(cutover.preflightProblem("cloudflare", HEALTHY)).toBeNull();
    });

    it("names the first thing in the way", () => {
        expect(cutover.preflightProblem("manual", { ...HEALTHY, deployed: false })).toBe(
            "target-not-deployed"
        );
        expect(cutover.preflightProblem("manual", { ...HEALTHY, running: false })).toBe(
            "target-not-running"
        );
        expect(cutover.preflightProblem("manual", { ...HEALTHY, newValue: null })).toBe("no-address");
        expect(cutover.preflightProblem("manual", { ...HEALTHY, answers: "not-routed" })).toBe(
            "target-not-routed"
        );
        expect(cutover.preflightProblem("manual", { ...HEALTHY, answers: "down" })).toBe("target-down");
    });

    it("needs no address when only the route moves", () => {
        expect(
            cutover.preflightProblem("edge", { ...HEALTHY, newValue: null, answers: "skipped" })
        ).toBeNull();
    });
});

describe("where a cutover starts", () => {
    it("stops before anything changes when the pre-flight fails", () => {
        expect(cutover.initialState("cloudflare", { ...HEALTHY, running: false }, 3600, NOW)).toEqual({
            phase: "preflight-failed",
            failure: "target-not-running",
            lowerUntil: null
        });
    });

    it("waits out the old TTL after lowering it", () => {
        const state = cutover.initialState("cloudflare", HEALTHY, 3600, NOW);
        expect(state.phase).toBe("lowering");
        expect(state.lowerUntil?.getTime()).toBe(NOW.getTime() + 3600 * 1000);
    });

    it("never waits longer than a day", () => {
        const state = cutover.initialState("cloudflare", HEALTHY, 7 * 86_400, NOW);
        expect(state.lowerUntil?.getTime()).toBe(NOW.getTime() + cutover.MAX_LOWER_WAIT_S * 1000);
    });

    it("is ready at once with a short TTL, a record by hand, or only a route to move", () => {
        expect(cutover.initialState("cloudflare", HEALTHY, cutover.LOWERED_TTL, NOW).phase).toBe("ready");
        expect(cutover.initialState("cloudflare", HEALTHY, 1, NOW).phase).toBe("ready");
        expect(cutover.initialState("manual", HEALTHY, 3600, NOW).phase).toBe("ready");
        expect(cutover.initialState("edge", { ...HEALTHY, answers: "skipped" }, null, NOW).phase).toBe(
            "ready"
        );
    });
});

describe("a background pass", () => {
    it("ends the lowering once the old TTL has run out", () => {
        const lowering = row({ phase: "lowering", lowerUntil: new Date(NOW.getTime() + 1000) });
        expect(cutover.tick(lowering, null, NOW).phase).toBe("lowering");
        expect(cutover.tick(lowering, null, new Date(NOW.getTime() + 1000)).phase).toBe("ready");
    });

    it("finishes only when the resolvers and the new service both agree", () => {
        const propagating = row({ phase: "propagating", switchedAt: NOW });
        expect(cutover.tick(propagating, { dnsSettled: true, targetUp: false }, NOW).phase).toBe(
            "propagating"
        );
        expect(cutover.tick(propagating, { dnsSettled: false, targetUp: true }, NOW).phase).toBe(
            "propagating"
        );
        expect(cutover.tick(propagating, { dnsSettled: true, targetUp: true }, NOW).phase).toBe(
            "finishing"
        );
    });

    it("gives up after the propagation limit, leaving the rollback open", () => {
        const propagating = row({ phase: "propagating", switchedAt: NOW });
        const late = new Date(NOW.getTime() + cutover.PROPAGATION_LIMIT_MS + 1);
        expect(cutover.tick(propagating, null, late)).toEqual({
            phase: "failed",
            failure: "propagation-timeout"
        });
        expect(cutover.canRollback("failed")).toBe(true);
    });

    it("is idempotent: the same row and observation give the same phase", () => {
        const propagating = row({ phase: "propagating", switchedAt: NOW });
        const observation = { dnsSettled: true, targetUp: true };
        expect(cutover.tick(propagating, observation, NOW)).toEqual(cutover.tick(propagating, observation, NOW));
        for (const phase of ["ready", "done", "rolled-back", "failed"] as const) {
            expect(cutover.tick(row({ phase }), observation, NOW).phase).toBe(phase);
        }
    });
});

describe("switching", () => {
    it("writes the record where Polaris holds the zone", () => {
        expect(cutover.switchEffects(row({ mode: "cloudflare" }))).toEqual(["write-record"]);
        expect(cutover.switchEffects(row({ mode: "cloudflare", phase: "lowering" }))).toEqual([
            "write-record"
        ]);
    });

    it("moves only the route behind a shared edge", () => {
        expect(cutover.switchEffects(row({ mode: "edge" }))).toEqual(["move-route", "republish"]);
    });

    it("writes nothing for a record changed by hand", () => {
        expect(cutover.switchEffects(row({ mode: "manual" }))).toEqual([]);
    });

    it("does nothing a second time", () => {
        for (const phase of ["propagating", "finishing", "done", "rolled-back"] as const) {
            expect(cutover.canSwitch(phase)).toBe(false);
            expect(cutover.switchEffects(row({ phase }))).toEqual([]);
        }
    });

    it("keeps the target's route staged until the cutover closes", () => {
        expect(cutover.stagesRoute("cloudflare", "ready")).toBe(true);
        expect(cutover.stagesRoute("manual", "propagating")).toBe(true);
        expect(cutover.stagesRoute("cloudflare", "finishing")).toBe(true);
        expect(cutover.stagesRoute("cloudflare", "done")).toBe(false);
        expect(cutover.stagesRoute("cloudflare", "rolled-back")).toBe(false);
        expect(cutover.stagesRoute("edge", "propagating")).toBe(false);
    });
});

describe("finishing", () => {
    it("hands the domain over and puts the TTL back", () => {
        expect(cutover.finishEffects(row({ phase: "finishing" }))).toEqual([
            "move-route",
            "restore-ttl",
            "republish"
        ]);
        expect(cutover.finishEffects(row({ phase: "finishing", mode: "manual" }))).toEqual([
            "move-route",
            "republish"
        ]);
        expect(cutover.finishEffects(row({ phase: "finishing", mode: "edge" }))).toEqual([]);
    });

    it("does nothing outside the finishing phase", () => {
        expect(cutover.finishEffects(row({ phase: "done" }))).toEqual([]);
        expect(cutover.isOpen("done")).toBe(false);
    });
});

describe("rolling back", () => {
    it("restores the record once it was written or its TTL lowered", () => {
        expect(
            cutover.rollbackEffects(row({ phase: "propagating", switchedAt: NOW, oldTtl: 300 }))
        ).toEqual(["restore-record", "republish"]);
        expect(cutover.rollbackEffects(row({ phase: "lowering", oldTtl: 3600 }))).toEqual([
            "restore-record",
            "republish"
        ]);
        expect(cutover.rollbackEffects(row({ phase: "ready", oldTtl: 60 }))).toEqual(["republish"]);
    });

    it("moves the route back behind a shared edge", () => {
        expect(
            cutover.rollbackEffects(row({ mode: "edge", phase: "propagating", switchedAt: NOW }))
        ).toEqual(["move-route-back", "republish"]);
    });

    it("only drops the staged route for a record changed by hand", () => {
        expect(cutover.rollbackEffects(row({ mode: "manual", phase: "failed", switchedAt: NOW }))).toEqual(
            ["republish"]
        );
    });

    it("does nothing once closed, so a second press is harmless", () => {
        for (const phase of ["done", "rolled-back", "preflight-failed", "finishing"] as const) {
            expect(cutover.rollbackEffects(row({ phase, switchedAt: NOW }))).toEqual([]);
        }
    });
});

describe("reading a stored row", () => {
    it("reads what it does not recognise as safe defaults", () => {
        expect(cutover.readList('["198.51.100.1"]')).toEqual(["198.51.100.1"]);
        expect(cutover.readList("not json")).toEqual([]);
        expect(cutover.readList('{"a":1}')).toEqual([]);
        expect(cutover.readPhase("propagating")).toBe("propagating");
        expect(cutover.readPhase("something-else")).toBe("failed");
        expect(cutover.readMode("edge")).toBe("edge");
        expect(cutover.readMode("other")).toBe("manual");
    });

    it("names the record to change by hand", () => {
        expect(cutover.manualRecord("shop.example.com", "203.0.113.7")).toEqual({
            type: "A",
            name: "shop.example.com",
            value: "203.0.113.7",
            ttl: cutover.LOWERED_TTL
        });
    });
});

describe("the routes a cutover stages on the edge", () => {
    const here = { kind: "local", hostId: null };
    const away = { kind: "host", hostId: "host-2" };
    const rows = [
        { id: "d1", servedBy: "auto", application: { target: here } },
        { id: "d2", servedBy: "auto", application: { target: here } }
    ];
    const targets = new Map([
        ["far", { id: "far", target: away }],
        ["near", { id: "near", target: here }]
    ]);

    it("routes a moving name on the target's edge while it is open", () => {
        const staged = cutover.stagedRoutes(
            rows,
            [{ domainId: "d1", targetApplicationId: "far", phase: "propagating", mode: "cloudflare" }],
            targets
        );
        expect(staged.map(({ row, target }) => [row.id, target.id])).toEqual([["d1", "far"]]);
    });

    it("routes nothing twice behind one edge, once closed, or for a missing row", () => {
        expect(
            cutover.stagedRoutes(
                rows,
                [
                    { domainId: "d1", targetApplicationId: "near", phase: "ready", mode: "manual" },
                    { domainId: "d2", targetApplicationId: "far", phase: "done", mode: "manual" },
                    { domainId: "gone", targetApplicationId: "far", phase: "ready", mode: "manual" },
                    { domainId: "d2", targetApplicationId: "missing", phase: "ready", mode: "manual" },
                    { domainId: "d2", targetApplicationId: "far", phase: "ready", mode: "edge" }
                ],
                targets
            )
        ).toEqual([]);
    });

    it("gives the same routes every time it is asked", () => {
        const staged = [
            { domainId: "d2", targetApplicationId: "far", phase: "lowering", mode: "manual" }
        ];
        expect(cutover.stagedRoutes(rows, staged, targets)).toEqual(
            cutover.stagedRoutes(rows, staged, targets)
        );
    });
});
