/**
 * A stopped service's addresses read "stopped", never "up".
 *
 * They answer with the not-running page on purpose, so probing them either
 * reports an outage that is not one or - behind a sign-in or a challenge that
 * answers first - reports them up, which is what a service stopped for weeks
 * showed. The pass marks them once and does not probe them at all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { VACANT_HEADER, VACANT_HEADER_VALUE } from "@polaris/core";

const mocks = vi.hoisted(() => ({ updateMany: vi.fn(), findMany: vi.fn(), update: vi.fn() }));

vi.mock("@polaris/db", () => ({
    prisma: { domain: { updateMany: mocks.updateMany, findMany: mocks.findMany, update: mocks.update } }
}));
vi.mock("@/lib/deploy-service", () => ({ syncAppRoutes: async () => undefined }));
vi.mock("@/lib/notifications/domain-events", () => ({
    notifyDomainHealthChanged: async () => undefined,
    notifyDomainHealthChanges: async () => undefined
}));

const { checkDomain, probeAllDomains, STOPPED_HEALTH } = await import("@/lib/watch/health-probe");

beforeEach(() => {
    mocks.updateMany.mockReset().mockResolvedValue({ count: 1 });
    mocks.findMany.mockReset().mockResolvedValue([]);
    mocks.update.mockReset().mockResolvedValue({});
    vi.unstubAllGlobals();
});

describe("a pass over the domains", () => {
    it("marks every domain of a stopped service stopped, once", async () => {
        await probeAllDomains();
        const call = mocks.updateMany.mock.calls[0]?.[0];
        expect(call.where.application).toEqual({ desiredState: "stopped" });
        // Only rows not already saying so: after the first pass this writes nothing.
        expect(call.where.healthStatus).toEqual({ not: STOPPED_HEALTH });
        expect(call.data.healthStatus).toBe(STOPPED_HEALTH);
        expect(call.data.healthFailures).toBe(0);
    });

    it("probes no domain of a stopped service", async () => {
        await probeAllDomains();
        expect(mocks.findMany.mock.calls[0]?.[0].where.application).toEqual({
            asleepSince: null,
            desiredState: { not: "stopped" }
        });
    });
});

describe("the not-running page", () => {
    it("is down whatever status reaches the probe, because it is Polaris answering for the app", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(
                async () =>
                    new Response("<html>not running</html>", {
                        status: 200,
                        headers: { "content-type": "text/html", [VACANT_HEADER]: VACANT_HEADER_VALUE }
                    })
            )
        );
        const health = await checkDomain({ hostname: "portfolio.plr.example.com", https: true });
        expect(health.status).toBe("down");
        expect(health.detail).toBe("Service not running");
    });
});
