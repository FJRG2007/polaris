/**
 * One CRM dashboard shared with somebody outside its shelf (`crm.dashboard`).
 * With a live grant it is in their list, marked shared, and each chart is
 * counted from the stored dashboard as a reader of only the kind it counts;
 * without one there is nothing; and only somebody who may change dashboards
 * where it lives may hand it out.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ID = "0192f0aa-0000-7000-8000-000000000002";
const WIDGETS = JSON.stringify([
    {
        id: "0192f0aa-0000-7000-8000-0000000000a1",
        title: "",
        object: "people",
        chart: "number",
        measure: "count",
        field: null,
        currency: null,
        groupBy: null,
        granularity: null,
        viewId: null,
        wide: false
    }
]);

const state = vi.hoisted(() => ({
    granted: new Map<string, string>(),
    rows: new Map<string, { orgId: string | null; userId: string | null; shelf: string }>(),
    readerArgs: null as unknown,
    orgPermissions: [] as string[]
}));

vi.mock("@polaris/app-host", () => ({
    host: {
        accessGrants: {
            grantedSubjects: vi.fn(async () => new Map(state.granted)),
            dropGrantsFor: vi.fn(async () => undefined)
        }
    }
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        crmDashboard: {
            findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
                const row = state.rows.get(where.id);
                return row ? { ...row, widgets: WIDGETS } : null;
            }),
            findMany: vi.fn(
                async ({ where }: { where: { id: { in: string[] }; shelf: { not: string } } }) =>
                    [...state.rows.entries()]
                        .filter(([id, row]) => where.id.in.includes(id) && row.shelf !== where.shelf.not)
                        .map(([id]) => ({ id, name: "Pipeline", widgets: WIDGETS }))
            )
        }
    }
}));
vi.mock("@polaris-app/crm/src/lib/i18n", () => ({ crmT: async () => (key: string) => key }));
vi.mock("@polaris-app/crm/src/lib/record-page", () => ({
    readerOn: vi.fn((...args: unknown[]) => {
        state.readerArgs = args;
        return { can: {} };
    })
}));
vi.mock("@polaris-app/crm/src/lib/access", () => ({
    // Reaching the count is all this test asks; the count itself is not under test.
    requireCan: vi.fn(async () => {
        throw new Error("counted");
    }),
    recordWhere: vi.fn(),
    requireShown: vi.fn(),
    shelfData: vi.fn()
}));

// What the sharing service asks of the other apps is not under test here.
vi.mock("@/lib/session", () => ({ sessionCan: vi.fn(async () => false) }));
vi.mock("@/lib/orgs/org-service", () => ({
    memberOrgIds: vi.fn(async () => []),
    resolveOrgAccess: vi.fn(async () => ({ permissions: state.orgPermissions })),
    orgCan: (access: { permissions: string[] } | null, permission: string) =>
        Boolean(access?.permissions.includes(permission))
}));
vi.mock("@/lib/access/grants", () => ({ GrantError: class GrantError extends Error {} }));
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

const { listSharedDashboards, sharedWidgetData } = await import(
    "@polaris-app/crm/src/lib/dashboards"
);
const { requireMayShare } = await import("@/lib/access/sharing-service");

const reader = { id: "reader", isAdmin: false } as Parameters<typeof requireMayShare>[0];
const owner = { id: "owner", isAdmin: false } as Parameters<typeof requireMayShare>[0];
const readerActor = { user: reader, shelf: { key: "user:reader" } } as never;

describe("a shared CRM dashboard", () => {
    beforeEach(() => {
        state.granted = new Map();
        state.rows = new Map([[ID, { orgId: null, userId: "owner", shelf: "user:owner" }]]);
        state.readerArgs = null;
        state.orgPermissions = [];
    });

    it("is in the reader's list with a grant, marked shared, and not without", async () => {
        expect(await listSharedDashboards(readerActor)).toEqual([]);
        state.granted = new Map([[ID, "view"]]);
        const list = await listSharedDashboards(readerActor);
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ id: ID, shared: true });
    });

    it("counts a stored chart as a reader of only its kind, on the owner's shelf", async () => {
        state.granted = new Map([[ID, "view"]]);
        await expect(sharedWidgetData(reader as never, ID, "0192f0aa-0000-7000-8000-0000000000a1")).rejects.toThrow("counted");
        expect(state.readerArgs).toEqual([reader, expect.objectContaining({ userId: "owner" }), ["people"]]);
    });

    it("refuses a chart without a grant, or one the dashboard does not hold", async () => {
        await expect(sharedWidgetData(reader as never, ID, "0192f0aa-0000-7000-8000-0000000000a1")).rejects.toThrow("errors.missing");
        state.granted = new Map([[ID, "view"]]);
        await expect(sharedWidgetData(reader as never, ID, "0192f0aa-0000-7000-8000-0000000000a2")).rejects.toThrow("errors.missing");
        expect(state.readerArgs).toBeNull();
    });

    it("may be handed out by its owner, or a role that edits records in the organization", async () => {
        await expect(requireMayShare(owner, "crm.dashboard", ID)).resolves.toBeUndefined();
        await expect(requireMayShare(reader, "crm.dashboard", ID)).rejects.toThrow();
        state.rows = new Map([[ID, { orgId: "org1", userId: null, shelf: "org:org1" }]]);
        await expect(requireMayShare(reader, "crm.dashboard", ID)).rejects.toThrow();
        state.orgPermissions = ["crm.people.edit"];
        await expect(requireMayShare(reader, "crm.dashboard", ID)).resolves.toBeUndefined();
    });
});
