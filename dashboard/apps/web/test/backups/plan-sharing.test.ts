/**
 * A backup plan shared with another administrator (`backup.plan`): listed
 * beside their own and marked shared, never replaced by them, and handed out
 * only by its owner.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const PLAN = "0192f0aa-0000-7000-8000-0000000000e1";

const state = vi.hoisted(() => ({ where: null as unknown, owned: 0 }));

vi.mock("@polaris/db", () => ({
    prisma: {
        backupPlan: {
            findMany: vi.fn(async (args: { where: unknown }) => {
                state.where = args.where;
                return [
                    {
                        id: "0192f0aa-0000-7000-8000-0000000000e1",
                        ownerId: "owner",
                        name: "nightly",
                        every: "daily",
                        keepLast: 7,
                        keepDays: 0,
                        maxBytes: 0n,
                        notifyOnFailure: true,
                        destinations: [],
                        _count: { resources: 2 }
                    }
                ];
            }),
            findUnique: vi.fn(async () => ({ ownerId: "owner" })),
            count: vi.fn(async () => state.owned),
            update: vi.fn()
        },
        backupDestination: { count: vi.fn(async () => 0) }
    }
}));
vi.mock("@/lib/access/grants", () => ({
    grantedSubjects: vi.fn(async () => new Map()),
    GrantError: class GrantError extends Error {}
}));
vi.mock("@/lib/session", () => ({ sessionCan: vi.fn(async () => false) }));
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

const manage = await import("@/lib/backups/manage");
const { requireMayShare } = await import("@/lib/access/sharing-service");

type Sharer = Parameters<typeof requireMayShare>[0];

describe("a shared backup plan", () => {
    beforeEach(() => {
        state.owned = 0;
    });

    it("is listed beside the reader's own plans, marked shared", async () => {
        const plans = await manage.listPlans("reader", new Set([PLAN]));
        expect(state.where).toEqual({ OR: [{ ownerId: "reader" }, { id: { in: [PLAN] } }] });
        expect(plans[0]).toMatchObject({ id: PLAN, shared: true, usedBy: 2 });
        await manage.listPlans("reader");
        expect(state.where).toEqual({ ownerId: "reader" });
    });

    it("is never replaced by somebody it was shared with", async () => {
        const input = {
            name: "x",
            every: "daily",
            keepLast: 1,
            keepDays: 0,
            maxBytes: 0,
            notifyOnFailure: true,
            destinationIds: []
        };
        await expect(manage.savePlan("reader", input as never, PLAN)).rejects.toThrow(
            "That plan does not exist"
        );
    });

    it("may be handed out by its owner and by nobody else", async () => {
        const as = (id: string) => ({ id, isAdmin: true }) as Sharer;
        await expect(requireMayShare(as("reader"), "backup.plan", PLAN)).rejects.toThrow();
        await expect(requireMayShare(as("owner"), "backup.plan", PLAN)).resolves.toBeUndefined();
    });
});
