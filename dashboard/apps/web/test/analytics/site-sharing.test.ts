/**
 * One service's visitor numbers shared with somebody who does not run it
 * (`analytics.site`). With a live grant they get into Analytics, are offered
 * only that service, and read its numbers marked shared and without the right
 * to share them on; without one they are turned away as before; and only
 * whoever configures the service may hand it out.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const APP = "0192f0aa-0000-7000-8000-0000000000c1";

const state = vi.hoisted(() => ({
    granted: new Map<string, string>(),
    manages: false,
    configures: false
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        application: {
            findUnique: vi.fn(async () => ({ id: APP, name: "shop" })),
            findMany: vi.fn(async () => [{ id: APP, name: "shop" }])
        },
        domain: { findMany: vi.fn(async () => [{ hostname: "Shop.example.test" }]) }
    }
}));
vi.mock("@/lib/access/grants", () => ({
    grantedSubjects: vi.fn(async () => new Map(state.granted)),
    GrantError: class GrantError extends Error {}
}));
vi.mock("@/lib/session", () => ({
    requireUser: vi.fn(async () => ({ id: "reader", isAdmin: false })),
    sessionCan: vi.fn(async () => state.manages),
    userHasManage: vi.fn(async () => false),
    requirePermission: vi.fn(async () => {
        throw new Error("denied");
    })
}));
vi.mock("@/lib/deploy-service", () => ({
    listProjectScopes: vi.fn(async () => []),
    visibleApplication: vi.fn(async () => null)
}));
vi.mock("@/lib/deploy-project-access", () => ({
    requireApplicationAccess: vi.fn(async () => {
        if (!state.configures) throw new Error("no");
    })
}));
vi.mock("@/lib/analytics-service", () => ({
    ensureAnalyticsSite: vi.fn(async (_type: string, id: string, name: string, hosts: string[]) => ({
        id: `site-${id}`,
        name,
        hosts
    })),
    readAnalytics: vi.fn(async () => ({ online: 0 })),
    recentVisits: vi.fn(async () => []),
    getAnalyticsSettings: vi.fn(async () => ({}))
}));
vi.mock("@/lib/audit-service", () => ({ recordAudit: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: vi.fn(async () => []) }));
vi.mock("@/lib/notes/access", () => ({ requireSpace: vi.fn() }));
vi.mock("@/lib/office/documents", () => ({ requireShareable: vi.fn() }));
vi.mock("@/lib/chat/access", () => ({ requireSpace: vi.fn(), requireChannel: vi.fn() }));
vi.mock("@/lib/tasks/access", () => ({ requireSpace: vi.fn(), requireFolder: vi.fn() }));
vi.mock("@/lib/machines/machine-access", () => ({ domainOwner: vi.fn(), lendableServer: vi.fn() }));
vi.mock("@/lib/local-machine", () => ({
    isLocalMachine: vi.fn(() => false),
    localMachineIdentity: vi.fn(async () => null)
}));
vi.mock("@/lib/local-server", () => ({
    getLocalServerName: vi.fn(async () => null),
    LOCAL_SERVER_FALLBACK_NAME: "This server"
}));

const actions = await import("@/app/(app)/apps/analytics/actions");
const { requireAnalyticsReader } = await import("@/app/(app)/apps/analytics/reader");
const { requireMayShare } = await import("@/lib/access/sharing-service");

const reader = { id: "reader", isAdmin: false } as Parameters<typeof requireMayShare>[0];
const overview = () => actions.getAnalyticsOverviewAction({ scopeType: "application", scopeId: APP, range: "24h" });

describe("a shared Analytics site", () => {
    beforeEach(() => {
        state.granted = new Map();
        state.manages = false;
        state.configures = false;
    });

    it("lets a grantee in, offering only what was shared", async () => {
        await expect(requireAnalyticsReader()).rejects.toThrow("denied");
        state.granted = new Map([[APP, "view"]]);
        expect((await requireAnalyticsReader()).lent).toEqual(new Set([APP]));
        expect((await actions.listAnalyticsSitesAction()).sites).toEqual([{ id: APP, label: "shop" }]);
    });

    it("reads the shared numbers marked shared, and nothing without a grant", async () => {
        state.manages = true;
        expect(await overview()).toEqual({ error: "errors.notYoursToSee" });
        state.granted = new Map([[APP, "view"]]);
        expect(await overview()).toMatchObject({
            site: { name: "shop", hosts: ["shop.example.test"] },
            shared: true,
            canShare: false
        });
    });

    it("may be handed out by whoever configures the service, and by nobody else", async () => {
        await expect(requireMayShare(reader, "analytics.site", APP)).rejects.toThrow();
        state.configures = true;
        await expect(requireMayShare(reader, "analytics.site", APP)).resolves.toBeUndefined();
    });
});
