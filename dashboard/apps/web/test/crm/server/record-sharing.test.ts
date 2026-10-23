/**
 * One CRM record shared with somebody outside its shelf (`crm.record`). With a
 * live grant they read its fields as a reader who may see that one kind and
 * change nothing, with no timeline, related records or shelf people; without
 * one - or once it is in the trash - there is nothing; and only somebody who
 * may change it where it lives may hand it out.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    granted: new Map<string, string>(),
    rows: new Map<string, { orgId: string | null; userId: string | null }>(),
    readAs: null as unknown,
    orgPermissions: [] as string[]
}));

vi.mock("@polaris/app-host", () => ({
    host: {
        accessGrants: { grantedSubjects: vi.fn(async () => new Map(state.granted)) }
    }
}));
vi.mock("@polaris/db", () => {
    const delegate = {
        findFirst: vi.fn(async ({ where }: { where: { id: string; deletedAt: null } }) => {
            return state.rows.get(where.id) ?? null;
        })
    };
    return { prisma: { crmCompany: delegate, crmPerson: delegate, crmOpportunity: delegate } };
});
vi.mock("@polaris-app/crm/src/lib/records", () => ({
    getRecord: vi.fn(async (actor: unknown, _object: string, id: string) => {
        state.readAs = actor;
        return { id, values: { name: "Acme" }, position: 0, deletedAt: null };
    }),
    shelfPeople: vi.fn(),
    shown: vi.fn()
}));
vi.mock("@polaris-app/crm/src/lib/fields", () => ({ loadFields: vi.fn(async () => []) }));
vi.mock("@polaris-app/crm/src/lib/timeline", () => ({ listTimeline: vi.fn() }));
vi.mock("@polaris-app/crm/src/lib/favorites", () => ({ pinnedAmong: vi.fn() }));

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

const { openSharedRecord } = await import("@polaris-app/crm/src/lib/record-page");
const { requireMayShare } = await import("@/lib/access/sharing-service");

const ID = "0192f0aa-0000-7000-8000-000000000001";
const reader = { id: "reader", isAdmin: false } as Parameters<typeof requireMayShare>[0];
const owner = { id: "owner", isAdmin: false } as Parameters<typeof requireMayShare>[0];

describe("a shared CRM record", () => {
    beforeEach(() => {
        state.granted = new Map();
        state.rows = new Map([[ID, { orgId: null, userId: "owner" }]]);
        state.readAs = null;
        state.orgPermissions = [];
    });

    it("opens read-only with a grant, with nothing around it", async () => {
        state.granted = new Map([[`companies:${ID}`, "view"]]);
        const opening = await openSharedRecord(reader as never, "companies", ID);
        expect(opening?.shared).toBe(true);
        expect(opening?.record?.id).toBe(ID);
        expect(opening?.related).toEqual([]);
        expect(opening?.people).toEqual([]);
        expect(opening?.timeline.events).toEqual([]);
        expect(opening?.can.companies).toEqual({ read: true, edit: false, delete: false });
        expect(opening?.can.people.read).toBe(false);
        expect(state.readAs).toMatchObject({ shelf: { orgId: null, userId: "owner" } });
    });

    it("is nothing without a grant, for another kind, or once it is in the trash", async () => {
        expect(await openSharedRecord(reader as never, "companies", ID)).toBeNull();
        state.granted = new Map([[`companies:${ID}`, "view"]]);
        expect(await openSharedRecord(reader as never, "people", ID)).toBeNull();
        state.rows = new Map();
        expect(await openSharedRecord(reader as never, "companies", ID)).toBeNull();
    });

    it("may be handed out by its owner on a personal shelf, and by nobody else", async () => {
        await expect(
            requireMayShare(owner, "crm.record", `companies:${ID}`)
        ).resolves.toBeUndefined();
        await expect(requireMayShare(reader, "crm.record", `companies:${ID}`)).rejects.toThrow();
        await expect(requireMayShare(owner, "crm.record", `widgets:${ID}`)).rejects.toThrow();
    });

    it("may be handed out on an organization's shelf by a role that edits that kind", async () => {
        state.rows = new Map([[ID, { orgId: "org1", userId: null }]]);
        await expect(requireMayShare(reader, "crm.record", `companies:${ID}`)).rejects.toThrow();
        state.orgPermissions = ["crm.companies.edit"];
        await expect(
            requireMayShare(reader, "crm.record", `companies:${ID}`)
        ).resolves.toBeUndefined();
    });
});
