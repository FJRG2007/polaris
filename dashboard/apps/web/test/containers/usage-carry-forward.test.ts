/**
 * What the table shows when the answer arrives without figures.
 *
 * The listing carries the last sample the server holds, and there is not always
 * one: a machine nobody has looked at since the process started, or a Docker
 * connection the metrics collector does not walk, answers with the containers and
 * nothing else. Meanwhile the table may already be showing numbers - from the
 * snapshot this tab kept, or from the poll before - and replacing those with
 * blanks is a screen going backwards on data it already had.
 *
 * So these pin down the three things that make carrying a reading forward honest:
 * it happens at all, it takes the instant the reading was taken with it (so the
 * header can go on saying how old it is), and it never happens for a container
 * that has stopped, where a number would read as though it were still working.
 */

import { describe, expect, it } from "vitest";
import { carryForwardUsage } from "../../src/app/(app)/apps/containers/usage";
import type { ContainerRow, HostSnapshot } from "../../src/app/(app)/apps/containers/types";

const SAMPLED_AT = 1_700_000_000_000;

function row(overrides: Partial<ContainerRow> = {}): ContainerRow {
    return {
        id: "c1",
        name: "web",
        image: "nginx",
        state: "running",
        status: "Up 2 hours",
        cpuPercent: 12.5,
        memUsage: 100_000_000,
        memPercent: 1.25,
        statsAt: SAMPLED_AT,
        ...overrides
    };
}

function snapshot(containers: ContainerRow[], statsAt: number | null): HostSnapshot {
    return {
        overview: {
            name: "docker-host",
            serverVersion: "27.0.0",
            containers: containers.length,
            running: containers.filter((entry) => entry.state === "running").length,
            stopped: containers.filter((entry) => entry.state !== "running").length,
            images: 4,
            ncpu: 16,
            memTotal: 32_000_000_000,
            aggregateCpuPercent: 0,
            aggregateMemUsage: 0
        },
        containers,
        canAttach: true,
        statsAt
    };
}

/** The answer a host with no sample gives: the containers, and no figures. */
function blank(overrides: Partial<ContainerRow> = {}): ContainerRow {
    return row({ cpuPercent: null, memUsage: null, memPercent: null, statsAt: null, ...overrides });
}

describe("a listing that comes back without usage", () => {
    it("keeps the reading the row already had", () => {
        const previous = snapshot([row()], SAMPLED_AT);

        const merged = carryForwardUsage(previous, snapshot([blank()], null));

        expect(merged.containers[0]?.cpuPercent).toBe(12.5);
        expect(merged.containers[0]?.memUsage).toBe(100_000_000);
    });

    it("carries when the reading was taken, so its age is still the truth", () => {
        const previous = snapshot([row()], SAMPLED_AT);

        const merged = carryForwardUsage(previous, snapshot([blank()], null));

        // Not "now": a number from four minutes ago that reports itself as this
        // instant's is worse than no number at all.
        expect(merged.containers[0]?.statsAt).toBe(SAMPLED_AT);
        expect(merged.statsAt).toBe(SAMPLED_AT);
    });

    it("leaves a container that has stopped blank", () => {
        const previous = snapshot([row()], SAMPLED_AT);

        const merged = carryForwardUsage(previous, snapshot([blank({ state: "exited" })], null));

        expect(merged.containers[0]?.cpuPercent).toBeNull();
        expect(merged.containers[0]?.statsAt).toBeNull();
    });

    it("prefers the fresh reading whenever there is one", () => {
        const previous = snapshot([row()], SAMPLED_AT);
        const fresher = row({ cpuPercent: 40, statsAt: SAMPLED_AT + 5_000 });

        const merged = carryForwardUsage(previous, snapshot([fresher], SAMPLED_AT + 5_000));

        expect(merged.containers[0]?.cpuPercent).toBe(40);
        expect(merged.statsAt).toBe(SAMPLED_AT + 5_000);
    });

    it("does not carry one container's figures onto another", () => {
        const previous = snapshot([row({ id: "c1" })], SAMPLED_AT);

        const merged = carryForwardUsage(previous, snapshot([blank({ id: "c2", name: "api" })], null));

        expect(merged.containers[0]?.cpuPercent).toBeNull();
    });

    it("hands back the same answer untouched when there is nothing to carry", () => {
        const fresh = snapshot([row()], SAMPLED_AT);

        // Same object, not a copy: an unchanged answer must not re-render the table.
        expect(carryForwardUsage(null, fresh)).toBe(fresh);
        expect(carryForwardUsage(snapshot([blank()], null), fresh)).toBe(fresh);
    });
});
