/**
 * One connection going down is one thing that happened, not one per service.
 *
 * Polaris is mostly run on somebody's own line, and what takes a domain down
 * there is hardly ever the domain. The line drops, and every domain on the box
 * fails its way to the alert threshold in the same pass; the line comes back and
 * they all recover in the same pass. Sent one at a time that is one alert per
 * deployed service - a handful on a small install, hundreds on a large one -
 * each one repeating the same sentence about the same cause, and none of them
 * saying the thing that actually happened.
 *
 * So the pass collects what crossed a threshold and speaks once at the end. What
 * is asserted here is that it does: not the wording, which is `domain-alerts`,
 * but that however many domains moved, the sweep hands them over together and
 * never alerts them one by one.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface DomainRow extends Record<string, unknown> {
    id: string;
    hostname: string;
    https: boolean;
    pathPrefix: string | null;
    healthFailures: number;
    healthAlertedAt: Date | null;
    application: { target: { kind: string } };
}

interface Change {
    domainId: string;
    status: string;
}

let domains: DomainRow[] = [];
/** Every batch the pass handed over, in order. */
let sweeps: Change[][] = [];
/** Alerts raised one domain at a time, which is what a sweep must not do. */
let singles = 0;

vi.mock("@polaris/db", () => ({
    prisma: {
        domain: {
            findMany: async () => domains,
            update: async () => ({})
        }
    }
}));

vi.mock("@/lib/deploy-service", () => ({
    syncAppRoutes: async () => undefined
}));

vi.mock("@/lib/notifications/domain-events", () => ({
    notifyDomainHealthChanged: async () => {
        singles += 1;
    },
    notifyDomainHealthChanges: async (changes: readonly Change[]) => {
        sweeps.push([...changes]);
    }
}));

/**
 * A domain the probe is about to find broken, one failure short of the threshold
 * so that this pass is the one that crosses it.
 */
function failing(id: string): DomainRow {
    return {
        id,
        hostname: `${id}.plr.example.com`,
        https: true,
        pathPrefix: null,
        healthFailures: 2,
        healthAlertedAt: null,
        application: { target: { kind: "local" } }
    };
}

/** And one somebody was already told about, so its recovery is news. */
function recovering(id: string): DomainRow {
    return { ...failing(id), healthFailures: 5, healthAlertedAt: new Date("2026-09-01T00:00:00Z") };
}

function answer(status: number): void {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("", { status }))
    );
}

async function pass(): Promise<void> {
    const { probeAllDomains } = await import("@/lib/watch/health-probe");
    await probeAllDomains();
}

beforeEach(() => {
    domains = [];
    sweeps = [];
    singles = 0;
    vi.resetModules();
    answer(200);
});

describe("when the line goes", () => {
    it("tells somebody once, naming everything that went with it", async () => {
        domains = [failing("shop"), failing("api"), failing("blog")];
        answer(503);

        await pass();

        expect(sweeps).toHaveLength(1);
        expect(sweeps[0]).toHaveLength(3);
        expect(sweeps[0]?.every((change) => change.status === "down")).toBe(true);
        expect(singles).toBe(0);
    });
});

describe("when it comes back", () => {
    it("says so once rather than once per service", async () => {
        domains = [recovering("shop"), recovering("api"), recovering("blog")];

        await pass();

        expect(sweeps).toHaveLength(1);
        expect(sweeps[0]?.map((change) => change.domainId).sort()).toEqual(["api", "blog", "shop"]);
        expect(sweeps[0]?.every((change) => change.status === "up")).toBe(true);
    });
});

describe("a pass where nothing crossed a threshold", () => {
    it("hands over an empty batch and says nothing", async () => {
        domains = [failing("shop")];

        await pass();

        // Up, and nobody had been told it was down: there is no news in that.
        expect(sweeps[0] ?? []).toHaveLength(0);
        expect(singles).toBe(0);
    });
});

describe("a single domain that moved on its own", () => {
    it("goes through the same door, so there is one place the wording is chosen", async () => {
        domains = [failing("shop")];
        answer(500);

        await pass();

        expect(sweeps).toHaveLength(1);
        expect(sweeps[0]).toHaveLength(1);
    });
});
