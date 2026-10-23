/**
 * One automation shared with somebody off its shelf (`automation.automation`).
 * With a live grant it is in their own list, marked shared and unfiled, and
 * opens to read; every change is refused, since it runs as whoever published
 * it; without a grant there is nothing; and only somebody who may change
 * automations on its shelf may hand it out.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ID = "0192f0aa-0000-7000-8000-0000000000b1";

const state = vi.hoisted(() => ({
    granted: new Map<string, string>(),
    row: null as null | { id: string; orgId: string | null; userId: string | null }
}));

function listed(row: { id: string; orgId: string | null; userId: string | null }) {
    return {
        ...row,
        name: "Nightly report",
        description: "",
        enabled: false,
        publishedVersionId: null,
        mode: "single",
        lastRunAt: null,
        lastStatus: null,
        updatedAt: new Date(),
        folderId: "f-owner",
        tags: []
    };
}

vi.mock("@polaris/db", () => ({
    prisma: {
        automation: {
            findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
                const row = state.row;
                if (!row) return [];
                const or = where.OR as { id?: { in: string[] } }[] | undefined;
                const lent = or?.find((one) => one.id)?.id?.in ?? [];
                const mine = !row.orgId && row.userId === (or ? "reader" : where.userId);
                return mine || lent.includes(row.id) ? [listed(row)] : [];
            }),
            findUnique: vi.fn(async () => (state.row ? { ...listed(state.row), draft: {} } : null))
        },
        automationTrigger: { findMany: vi.fn(async () => []) }
    }
}));
vi.mock("@/lib/access/grants", () => ({
    grantedSubjects: vi.fn(async () => new Map(state.granted)),
    dropGrantsFor: vi.fn(async () => undefined),
    GrantError: class GrantError extends Error {}
}));
vi.mock("@/lib/session", () => ({ sessionCan: vi.fn(async () => false) }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: vi.fn() }));
vi.mock("@/lib/orgs/org-service", () => ({
    memberOrgIds: vi.fn(async () => []),
    resolveOrgAccess: vi.fn(async () => null),
    orgCan: vi.fn(() => false)
}));
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

const service = await import("@/lib/automations/service");
const { requireMayShare } = await import("@/lib/access/sharing-service");

const reader = { id: "reader", isAdmin: false };
const owner = { id: "owner", isAdmin: false };
const readerShelf = { orgId: null, userId: "reader" };

describe("a shared automation", () => {
    beforeEach(() => {
        state.granted = new Map();
        state.row = { id: ID, orgId: null, userId: "owner" };
    });

    it("is in the reader's own list with a grant, marked shared and unfiled", async () => {
        expect((await service.listAutomations(reader, readerShelf)).rows).toEqual([]);
        state.granted = new Map([[ID, "view"]]);
        const { rows } = await service.listAutomations(reader, readerShelf);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: ID, shared: true, folderId: null });
    });

    it("opens to read with a grant and refuses every change", async () => {
        await expect(service.load(reader, ID, false)).rejects.toThrow();
        state.granted = new Map([[ID, "view"]]);
        await expect(service.load(reader, ID, false)).resolves.toMatchObject({ id: ID });
        await expect(service.load(reader, ID, true)).rejects.toThrow();
    });

    it("stays the owner's own, unmarked", async () => {
        const { rows } = await service.listAutomations(owner, { orgId: null, userId: "owner" });
        expect(rows[0]?.shared).toBeUndefined();
        await expect(service.load(owner, ID, true)).resolves.toMatchObject({ id: ID });
    });

    it("may be handed out by whoever may change it, and by nobody else", async () => {
        await expect(requireMayShare(owner as never, "automation.automation", ID)).resolves.toBeUndefined();
        await expect(requireMayShare(reader as never, "automation.automation", ID)).rejects.toThrow();
    });
});
