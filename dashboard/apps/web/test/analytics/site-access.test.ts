/**
 * Per-site access in Analytics: a site shared to view reads its numbers and
 * reports but changes nothing; shared to edit it may also run the tracker,
 * reports, ignore rules and wipe the history; without either nothing is read,
 * not even through the export route. Sharing on stays with whoever configures.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const APP = "0192f0aa-0000-7000-8000-0000000000d1";
const REPORT = "0192f0aa-0000-7000-8000-0000000000e1";

const state = vi.hoisted(() => ({ granted: new Map<string, string>(), configures: false, manages: false }));
const service = vi.hoisted(() => ({
    setTrackerEnabled: vi.fn(async () => undefined),
    rotateTrackerKey: vi.fn(async () => "new-key"),
    setSiteRules: vi.fn(async () => undefined)
}));
const reports = vi.hoisted(() => ({
    saveReport: vi.fn(async () => "0192f0aa-0000-7000-8000-0000000000e1"),
    deleteReport: vi.fn(async () => true),
    resetSiteData: vi.fn(async () => undefined),
    listReports: vi.fn(async () => []),
    previousPeriod: vi.fn(async () => null),
    funnel: vi.fn(async () => [])
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        application: {
            findUnique: vi.fn(async () => ({ id: APP, name: "shop" })),
            findMany: vi.fn(async () => [{ id: APP, name: "shop" }])
        },
        domain: { findMany: vi.fn(async () => []) }
    }
}));
vi.mock("@/lib/access/grants", () => ({
    grantedSubjects: vi.fn(async () => new Map(state.granted))
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
    ensureAnalyticsSite: vi.fn(async (type: string, id: string, name: string) => ({
        id: `site-${id}`,
        scopeType: type,
        name
    })),
    readAnalytics: vi.fn(async () => ({ from: 0, to: 1, source: "raw" })),
    recentVisits: vi.fn(async () => []),
    getAnalyticsSettings: vi.fn(async () => ({})),
    setAnalyticsSettings: vi.fn(),
    ...service
}));
vi.mock("@/lib/analytics-reports", () => ({ ...reports, sessionWhere: () => ({}) }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/download-ticket", () => ({ downloadTicketHeaders: () => ({}) }));

const actions = await import("@/app/(app)/analytics/actions");
const scope = { scopeType: "application", scopeId: APP };
const funnel = JSON.stringify({
    kind: "funnel",
    definition: {
        steps: [
            { type: "path", value: "/" },
            { type: "event", value: "signup" }
        ],
        windowMinutes: 60
    }
});

async function writes() {
    return [
        await actions.setTrackerEnabledAction({ ...scope, enabled: true }),
        await actions.rotateTrackerKeyAction(scope),
        await actions.setSiteRulesAction({ ...scope, rules: { excludedPaths: ["/admin*"], ignoredIps: [] } }),
        await actions.resetSiteDataAction(scope),
        await actions.saveAnalyticsReportAction({
            ...scope,
            report: { kind: "goal", name: "Signed up", definition: { type: "event", value: "signup" } }
        }),
        await actions.deleteAnalyticsReportAction({ ...scope, id: REPORT })
    ];
}

beforeEach(() => {
    vi.clearAllMocks();
    state.granted = new Map();
    state.configures = false;
    state.manages = false;
});

describe("analytics per-site access", () => {
    it("reads nothing without a grant, through actions or the export route", async () => {
        state.granted = new Map([["some-other-app", "view"]]);
        expect(await actions.getAnalyticsOverviewAction({ ...scope, range: "24h" })).toEqual({
            error: "errors.notYoursToSee"
        });
        expect(
            await actions.runAnalyticsReportAction({ ...scope, range: "24h", request: funnel })
        ).toEqual({ error: "errors.notYoursToSee" });
        const { GET } = await import("@/app/api/analytics/export/route");
        const response = await GET(
            new Request(`https://polaris.test/api/analytics/export?scopeType=application&scopeId=${APP}&range=24h`)
        );
        expect(response.status).toBe(404);
        expect(reports.funnel).not.toHaveBeenCalled();
    });

    it("lets a viewer read and run reports, and change nothing", async () => {
        state.granted = new Map([[APP, "view"]]);
        expect(await actions.getAnalyticsOverviewAction({ ...scope, range: "24h" })).toMatchObject({
            level: "view",
            shared: true,
            canShare: false
        });
        expect(
            await actions.runAnalyticsReportAction({ ...scope, range: "24h", request: funnel })
        ).toMatchObject({ kind: "funnel" });
        for (const result of await writes()) expect(result.error).toBe("errors.notYoursToChange");
        expect(service.setTrackerEnabled).not.toHaveBeenCalled();
        expect(service.setSiteRules).not.toHaveBeenCalled();
        expect(reports.resetSiteData).not.toHaveBeenCalled();
        expect(reports.saveReport).not.toHaveBeenCalled();
        expect(reports.deleteReport).not.toHaveBeenCalled();
    });

    it("lets an editor change the site, but not share it on", async () => {
        state.granted = new Map([[APP, "edit"]]);
        expect(await actions.getAnalyticsOverviewAction({ ...scope, range: "24h" })).toMatchObject({
            level: "edit",
            canShare: false
        });
        for (const result of await writes()) expect(result.error).toBeUndefined();
        expect(service.setTrackerEnabled).toHaveBeenCalledWith(`site-${APP}`, true);
        expect(service.setSiteRules).toHaveBeenCalledWith(`site-${APP}`, {
            excludedPaths: ["/admin*"],
            ignoredIps: []
        });
        expect(reports.resetSiteData).toHaveBeenCalledWith(`site-${APP}`);
    });

    it("lets whoever configures the service own it", async () => {
        state.configures = true;
        state.manages = true;
        expect(await actions.getAnalyticsOverviewAction({ ...scope, range: "24h" })).toMatchObject({
            level: "own",
            canShare: true,
            shared: false
        });
    });

    it("refuses a malformed report or rule set even from an editor", async () => {
        state.granted = new Map([[APP, "edit"]]);
        expect(
            await actions.runAnalyticsReportAction({ ...scope, range: "24h", request: "{\"kind\":\"funnel\"}" })
        ).toEqual({ error: "errors.report" });
        expect(
            await actions.setSiteRulesAction({ ...scope, rules: { excludedPaths: ["no-slash"], ignoredIps: [] } })
        ).toEqual({ error: "errors.rules" });
        expect(service.setSiteRules).not.toHaveBeenCalled();
    });

    it("lists a site shared with somebody", async () => {
        state.granted = new Map([[APP, "edit"]]);
        expect((await actions.listAnalyticsSitesAction()).sites).toEqual([{ id: APP, label: "shop" }]);
    });
});
