/**
 * Switching a site's tracker off, or rotating its key, takes the right to
 * configure that service - not only the right to see it.
 *
 * Every account sees a service on an internal project, and a read-only project
 * member sees services they cannot change. Either stopping another project's
 * analytics is a write, so it is cleared the way every other service write is.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const APP = "018f2b7a-0000-7000-8000-0000000000a1";

const visibleApplication = vi.fn(async () => ({ id: APP, name: "Shop", environmentId: "env-1" }));
const requireApplicationAccess = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({}));
const setTrackerEnabled = vi.fn(async () => undefined);
const rotateTrackerKey = vi.fn(async () => "new-key");

vi.mock("@polaris/db", () => ({ prisma: { domain: { findMany: async () => [] } } }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/session", () => ({
    requirePermission: async () => ({ id: "u1", isAdmin: false }),
    userHasManage: async () => false
}));
vi.mock("@/lib/deploy-service", () => ({
    listProjectScopes: async () => [],
    visibleApplication: (...args: unknown[]) => visibleApplication(...(args as []))
}));
vi.mock("@/lib/deploy-project-access", () => ({
    requireApplicationAccess: (...args: unknown[]) => requireApplicationAccess(...args)
}));
vi.mock("@/lib/analytics-service", () => ({
    getAnalyticsSettings: async () => ({}),
    readAnalytics: async () => ({}),
    recentVisits: async () => [],
    rotateTrackerKey: (...args: unknown[]) => rotateTrackerKey(...(args as [])),
    setAnalyticsSettings: async () => undefined,
    setTrackerEnabled: (...args: unknown[]) => setTrackerEnabled(...(args as [])),
    ensureAnalyticsSite: async () => ({ id: "site-1" })
}));

const actions = await import("../../src/app/(app)/apps/analytics/actions");

beforeEach(() => {
    vi.clearAllMocks();
    requireApplicationAccess.mockResolvedValue({});
});

describe("tracker writes", () => {
    it("are refused to somebody who can see the service but not configure it", async () => {
        requireApplicationAccess.mockRejectedValue(new Error("Service not found"));

        const off = await actions.setTrackerEnabledAction({ scopeType: "application", scopeId: APP, enabled: false });
        const rotated = await actions.rotateTrackerKeyAction({ scopeType: "application", scopeId: APP });

        expect(off.error).toBeTruthy();
        expect(rotated.error).toBeTruthy();
        expect(setTrackerEnabled).not.toHaveBeenCalled();
        expect(rotateTrackerKey).not.toHaveBeenCalled();
    });

    it("go through for somebody who configures it", async () => {
        await actions.rotateTrackerKeyAction({ scopeType: "application", scopeId: APP });
        expect(requireApplicationAccess).toHaveBeenCalledWith(APP, "u1", "service.configure");
        expect(rotateTrackerKey).toHaveBeenCalledWith("site-1");
    });
});
