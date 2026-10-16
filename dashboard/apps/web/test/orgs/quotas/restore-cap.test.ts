/**
 * Restoring from the recycle bin is one more of what comes back: a binned service
 * counts toward no cap, so bringing it into an organization at its service cap is
 * refused before anything is un-binned, and the same restore under the cap goes
 * through. The database and the deploy service are fakes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "00000000-0000-7000-8000-0000000000bb";
const ORG = "00000000-0000-7000-8000-0000000000cc";
const APP = "00000000-0000-7000-8000-0000000000ee";

const state = vi.hoisted(() => ({
    quota: null as Record<string, number | null> | null,
    services: 0,
    updates: [] as string[]
}));

vi.mock("@polaris/db", () => ({
    INCLUDING_BINNED: { binnedAt: undefined },
    prisma: {
        organizationQuota: { findUnique: async () => state.quota },
        project: { findFirst: async () => null },
        application: {
            findFirst: async () => ({
                replicas: 1,
                cpuLimit: null,
                memoryLimitMb: null,
                environment: { project: { ownerId: OWNER, orgId: ORG } }
            }),
            count: async () => state.services,
            update: async () => {
                state.updates.push("application");
                return {};
            }
        },
        domain: { updateMany: async () => ({ count: 0 }) }
    }
}));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async () => null,
    setSetting: async () => undefined
}));
vi.mock("@/lib/restore-points/service", () => ({
    listRestorePoints: async () => [],
    restoreKeys: { routes: (id: string) => id }
}));
vi.mock("@/lib/deploy-project-access", () => ({
    managedProjectWhere: async () => ({ ownerId: OWNER })
}));
vi.mock("@/lib/deploy-service", () => ({
    syncAppRoutes: async () => undefined,
    deployApplication: async () => undefined
}));
vi.mock("@/lib/i18n/request", () => ({
    getTranslations: async () => {
        throw new Error("outside a request");
    }
}));

const recycleBin = await import("@/lib/deploy/recycle-bin");
const { OrgQuotaError } = await import("@/lib/orgs/quota-service");

beforeEach(() => {
    state.quota = null;
    state.services = 0;
    state.updates = [];
});

describe("restoring into an organization with caps", () => {
    it("refuses a service at the service cap and leaves it in the bin", async () => {
        state.quota = { services: 2 };
        state.services = 2;
        await expect(
            recycleBin.restoreFromBin("application", APP, OWNER, OWNER)
        ).rejects.toBeInstanceOf(OrgQuotaError);
        expect(state.updates).toEqual([]);
    });

    it("restores a service under the cap", async () => {
        state.quota = { services: 2 };
        state.services = 1;
        await recycleBin.restoreFromBin("application", APP, OWNER, OWNER);
        expect(state.updates).toEqual(["application"]);
    });

    it("restores freely where no cap was set", async () => {
        state.services = 500;
        await recycleBin.restoreFromBin("application", APP, OWNER, OWNER);
        expect(state.updates).toEqual(["application"]);
    });
});
