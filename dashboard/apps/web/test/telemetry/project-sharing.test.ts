/**
 * One telemetry project shared with somebody who does not own it
 * (`telemetry.project`). With a live grant they get into Telemetry, see the
 * project marked shared with its reporter rules and refusals blanked, and open
 * its issues; changing an issue stays refused; and only the owner (or an
 * administrator) may hand it out.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const PROJECT = "0192f0aa-0000-7000-8000-0000000000d1";

const state = vi.hoisted(() => ({
    granted: new Map<string, string>(),
    manages: false,
    where: null as unknown
}));

const row = {
    id: "0192f0aa-0000-7000-8000-0000000000d1",
    ownerId: "owner",
    number: 123456789,
    name: "shop",
    slug: "shop",
    platform: "node",
    publicKey: "k",
    enabled: true,
    system: false,
    retentionDays: 30,
    deployProjectId: null,
    orgId: null,
    reporters: "{}",
    allowedCidrs: '["10.0.0.0/8"]',
    allowedUserAgents: "[]",
    deniedUserAgents: "[]",
    requireSecret: false,
    secretHash: null,
    secretTail: null,
    refusedCount: 2,
    refusedAt: null,
    refusedIp: "203.0.113.9",
    refusedAgent: "curl",
    refusedReason: null,
    issues: []
};

vi.mock("@polaris/db", () => ({
    prisma: {
        telemetryProject: {
            findMany: vi.fn(async (args: { where: unknown }) => {
                state.where = args.where;
                return state.granted.size > 0 ? [row] : [];
            }),
            findUnique: vi.fn(async () => row)
        }
    }
}));
vi.mock("@/lib/access/grants", () => ({
    grantedSubjects: vi.fn(async () => new Map(state.granted)),
    dropGrantsFor: vi.fn(),
    GrantError: class GrantError extends Error {}
}));
vi.mock("@/lib/session", () => ({
    requireUser: vi.fn(async () => ({ id: "reader", isAdmin: false })),
    sessionCan: vi.fn(async () => state.manages),
    requirePermission: vi.fn(async () => {
        if (!state.manages) throw new Error("denied");
        return { id: "reader", isAdmin: false };
    })
}));
vi.mock("@/lib/telemetry/report-service", () => ({
    TELEMETRY_WINDOW_DAYS: 30,
    listIssues: vi.fn(async () => [{ id: "i1" }]),
    issueCounts: vi.fn(async () => ({ unresolved: 1 })),
    getIssue: vi.fn(async () => ({ id: "i1" })),
    setIssueStatus: vi.fn()
}));
vi.mock("@/lib/domain-service", () => ({
    appBaseUrl: vi.fn(async () => "https://polaris.example.test")
}));
vi.mock("@/lib/workspace-scope", () => ({ scopeOrgIdFor: vi.fn(async () => null) }));
vi.mock("@polaris/deploy", () => ({ slugify: (value: string) => value }));
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

const actions = await import("@/app/(app)/apps/telemetry/actions");
const { requireTelemetryReader } = await import("@/lib/telemetry/reader");
const { requireMayShare } = await import("@/lib/access/sharing-service");

type Sharer = Parameters<typeof requireMayShare>[0];

describe("a shared telemetry project", () => {
    beforeEach(() => {
        state.granted = new Map();
        state.manages = false;
    });

    it("lets a grantee in only with a grant", async () => {
        await expect(requireTelemetryReader()).rejects.toThrow("denied");
        state.granted = new Map([[PROJECT, "view"]]);
        expect((await requireTelemetryReader()).lent).toEqual(new Set([PROJECT]));
    });

    it("lists it marked shared, without the owner's rules or refusals, and opens its issues", async () => {
        state.granted = new Map([[PROJECT, "view"]]);
        const { data } = await actions.telemetryOverviewAction({ projectId: PROJECT });
        expect(state.where).toMatchObject({
            OR: [{ ownerId: "reader" }, { id: { in: [PROJECT] } }]
        });
        expect(data?.projects[0]).toMatchObject({
            shared: true,
            refused: { ip: null, agent: null }
        });
        expect(data?.projects[0]?.rules.allowedCidrs).toEqual([]);
        expect(data?.issues).toEqual([{ id: "i1" }]);
        expect(await actions.openIssueAction(PROJECT, "i1")).toEqual({ issue: { id: "i1" } });
    });

    it("refuses a grantee every change", async () => {
        state.granted = new Map([[PROJECT, "view"]]);
        state.manages = true;
        expect(await actions.setIssueStatusAction(PROJECT, "i1", "resolved")).toEqual({
            error: "errors.noAccess"
        });
    });

    it("may be handed out by its owner or an administrator, and by nobody else", async () => {
        const as = (id: string, isAdmin = false) => ({ id, isAdmin }) as Sharer;
        await expect(requireMayShare(as("reader"), "telemetry.project", PROJECT)).rejects.toThrow();
        await expect(
            requireMayShare(as("owner"), "telemetry.project", PROJECT)
        ).resolves.toBeUndefined();
        await expect(
            requireMayShare(as("admin", true), "telemetry.project", PROJECT)
        ).resolves.toBeUndefined();
    });
});
