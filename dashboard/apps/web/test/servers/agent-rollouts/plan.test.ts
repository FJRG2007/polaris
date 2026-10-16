/**
 * The rollout rules: wave sizes, who is left out and why, the health gate an
 * updated server has to pass, when a wave halts the rollout, and what a
 * rollback pins.
 */

import { describe, expect, it } from "vitest";
import * as plan from "@/lib/agent-rollouts/plan";

const server = (id: string, version: string | null = "1.0.0", pinnedVersion: string | null = null) => ({
    id,
    version,
    pinnedVersion
});

describe("waveSizes", () => {
    it("starts with a one-server canary and reaches everyone", () => {
        expect(plan.waveSizes(20, [1, 10, 50, 100])).toEqual([1, 2, 10, 20]);
    });

    it("drops waves that would reach nobody new", () => {
        expect(plan.waveSizes(3, [1, 10, 50, 100])).toEqual([1, 2, 3]);
        expect(plan.waveSizes(1, [1, 10, 50, 100])).toEqual([1]);
    });

    it("plans nothing for no servers", () => {
        expect(plan.waveSizes(0, [1, 100])).toEqual([]);
    });

    it("still reaches everyone when the last wave stops short", () => {
        expect(plan.waveSizes(10, [2])).toEqual([2, 10]);
    });
});

describe("validWaves / parseWaves", () => {
    it("accepts a canary followed by rising percentages ending at 100", () => {
        expect(plan.validWaves([1, 25, 100])).toBe(true);
        expect(plan.validWaves([3])).toBe(true);
    });

    it("refuses falling, out of range, or unfinished lists", () => {
        expect(plan.validWaves([1, 50, 10, 100])).toBe(false);
        expect(plan.validWaves([0, 100])).toBe(false);
        expect(plan.validWaves([1, 50])).toBe(false);
        expect(plan.validWaves([])).toBe(false);
    });

    it("falls back to the default for a malformed stored value", () => {
        expect(plan.parseWaves("not json")).toEqual([...plan.DEFAULT_WAVES]);
        expect(plan.parseWaves("[1,25,100]")).toEqual([1, 25, 100]);
    });
});

describe("planRollout", () => {
    it("leaves out agentless, pinned and already-current servers", () => {
        const targets = plan.planRollout(
            [
                server("a"),
                server("b", null),
                server("c", "1.0.0", "1.0.0"),
                server("d", "2.0.0"),
                server("e", "1.0.0", "2.0.0")
            ],
            "2.0.0",
            [1, 100]
        );
        const by = Object.fromEntries(targets.map((target) => [target.serverId, target]));
        expect(by.a).toMatchObject({ state: "pending", wave: 0 });
        expect(by.b).toMatchObject({ state: "skipped", reason: "no-agent" });
        expect(by.c).toMatchObject({ state: "skipped", reason: "pinned" });
        expect(by.d).toMatchObject({ state: "skipped", reason: "current" });
        // Pinned to exactly the version being rolled out: included.
        expect(by.e).toMatchObject({ state: "pending", wave: 1 });
    });

    it("assigns the same waves however the servers arrive", () => {
        const ids = Array.from({ length: 10 }, (_, index) => `s${index}`);
        const one = plan.planRollout(ids.map((id) => server(id)), "2.0.0", [1, 50, 100]);
        const two = plan.planRollout(
            [...ids].reverse().map((id) => server(id)),
            "2.0.0",
            [1, 50, 100]
        );
        const waves = (list: plan.PlannedTarget[]) =>
            Object.fromEntries(list.map((target) => [target.serverId, target.wave]));
        expect(waves(one)).toEqual(waves(two));
        expect(one.filter((target) => target.wave === 0)).toHaveLength(1);
        expect(one.filter((target) => target.wave === 1)).toHaveLength(4);
        expect(one.filter((target) => target.wave === 2)).toHaveLength(5);
    });
});

describe("previousVersion", () => {
    it("is the version most servers run, ignoring the target and agentless ones", () => {
        expect(
            plan.previousVersion(
                [server("a", "1.0.0"), server("b", "1.0.0"), server("c", "0.9.0"), server("d", null)],
                "2.0.0"
            )
        ).toBe("1.0.0");
        expect(plan.previousVersion([server("a", "2.0.0")], "2.0.0")).toBeNull();
    });
});

describe("stepTarget", () => {
    const start = new Date("2026-10-16T10:00:00Z");
    const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);
    const config = { version: "2.0.0", healthMs: 10 * 60_000 };

    it("moves to verifying once the server reports the version with a fresh heartbeat", () => {
        const step = plan.stepTarget(
            { state: "updating", startedAt: start, healthySince: null },
            { version: "2.0.0", heartbeatAt: at(2) },
            at(2),
            config
        );
        expect(step).toEqual({ state: "verifying", healthySince: at(2), reason: null });
    });

    it("keeps waiting for an update in progress, and fails one that never reports", () => {
        const target = { state: "updating" as const, startedAt: start, healthySince: null };
        expect(plan.stepTarget(target, { version: "1.0.0", heartbeatAt: at(5) }, at(5), config).state).toBe(
            "updating"
        );
        expect(
            plan.stepTarget(target, { version: "1.0.0", heartbeatAt: at(31) }, at(31), config)
        ).toMatchObject({ state: "failed", reason: "timeout" });
    });

    it("is healthy only after the whole health window", () => {
        const target = { state: "verifying" as const, startedAt: start, healthySince: at(2) };
        expect(plan.stepTarget(target, { version: "2.0.0", heartbeatAt: at(9) }, at(9), config).state).toBe(
            "verifying"
        );
        expect(plan.stepTarget(target, { version: "2.0.0", heartbeatAt: at(12) }, at(12), config).state).toBe(
            "healthy"
        );
    });

    it("fails a server that stops answering or goes back to another version", () => {
        const target = { state: "verifying" as const, startedAt: start, healthySince: at(2) };
        expect(
            plan.stepTarget(target, { version: "2.0.0", heartbeatAt: at(3) }, at(8), config)
        ).toMatchObject({ state: "failed", reason: "heartbeat" });
        expect(
            plan.stepTarget(target, { version: "1.0.0", heartbeatAt: at(5) }, at(5), config)
        ).toMatchObject({ state: "failed", reason: "version" });
    });
});

describe("waveVerdict", () => {
    it("halts on any failure, advances when all are healthy or skipped, waits otherwise", () => {
        expect(plan.waveVerdict(["healthy", "failed", "verifying"])).toBe("halt");
        expect(plan.waveVerdict(["healthy", "skipped"])).toBe("advance");
        expect(plan.waveVerdict(["healthy", "verifying"])).toBe("wait");
        expect(plan.waveVerdict(["pending"])).toBe("wait");
    });
});

describe("rollbackPins", () => {
    it("pins every server the rollout reached, and none it did not", () => {
        expect(
            plan.rollbackPins([
                { serverId: "a", state: "healthy" },
                { serverId: "b", state: "failed" },
                { serverId: "c", state: "pending" },
                { serverId: "d", state: "skipped" },
                { serverId: "e", state: "verifying" }
            ])
        ).toEqual(["a", "b", "e"]);
    });
});
