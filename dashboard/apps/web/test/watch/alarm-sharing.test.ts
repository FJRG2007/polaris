/**
 * One Watch alarm, shared. The person it was shared with sees it in their own
 * list, marked as shared and named by what it watches; without a live grant -
 * never given, or taken back - it is not there; and only whoever made it may
 * hand it out. Changing and deleting stay owner-scoped in the service itself.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    granted: new Map<string, string>(),
    alarms: [] as { id: string; ownerId: string; targetType: string; targetId: string }[]
}));

function row(one: { id: string; ownerId: string; targetType: string; targetId: string }) {
    return {
        ...one,
        name: `Alarm ${one.id}`,
        metric: "cpu",
        operator: "gt",
        threshold: 90,
        forPeriods: 1,
        enabled: true,
        state: "ok",
        lastEvaluatedAt: null,
        carriedToId: null,
        createdAt: new Date()
    };
}

vi.mock("@polaris/db", () => ({
    prisma: {
        alarm: {
            findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
                if (typeof where.ownerId === "string") {
                    return state.alarms.filter((one) => one.ownerId === where.ownerId).map(row);
                }
                const ids = (where.id as { in: string[] }).in;
                const not = (where.ownerId as { not: string }).not;
                return state.alarms
                    .filter((one) => ids.includes(one.id) && one.ownerId !== not)
                    .map(row);
            }),
            findFirst: vi.fn(
                async ({ where }: { where: { id: string; ownerId: string } }) =>
                    state.alarms.find(
                        (one) => one.id === where.id && one.ownerId === where.ownerId
                    ) ?? null
            )
        },
        host: { findMany: vi.fn(async () => [{ id: "h1", name: "garage-box" }]) },
        application: { findMany: vi.fn(async () => []) },
        domain: { findMany: vi.fn(async () => []) }
    }
}));

vi.mock("@/lib/access/grants", () => ({
    grantedSubjects: vi.fn(async () => state.granted),
    dropGrantsFor: vi.fn(async () => undefined),
    GrantError: class GrantError extends Error {}
}));

// What the sharing service asks of the other apps is not under test here.
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

const { listAlarms } = await import("@/lib/watch-service");
const { requireMayShare } = await import("@/lib/access/sharing-service");

const owner = { id: "owner", isAdmin: false } as Parameters<typeof requireMayShare>[0];
const reader = { id: "reader", isAdmin: false } as Parameters<typeof requireMayShare>[0];

describe("a shared alarm", () => {
    beforeEach(() => {
        state.granted = new Map();
        state.alarms = [{ id: "a1", ownerId: "owner", targetType: "host", targetId: "h1" }];
    });

    it("is in the reader's list with the grant, marked and named", async () => {
        state.granted = new Map([["a1", "view"]]);
        const list = await listAlarms("reader");
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ id: "a1", shared: true, targetLabel: "garage-box" });
    });

    it("is not there without a grant, or once it is taken back", async () => {
        expect(await listAlarms("reader")).toEqual([]);
        state.granted = new Map([["a1", "view"]]);
        expect(await listAlarms("reader")).toHaveLength(1);
        state.granted = new Map();
        expect(await listAlarms("reader")).toEqual([]);
    });

    it("stays the owner's own, unmarked, in the owner's list", async () => {
        const list = await listAlarms("owner");
        expect(list).toHaveLength(1);
        expect(list[0].shared).toBeUndefined();
    });

    it("may be handed out by whoever made it, and by nobody else", async () => {
        await expect(requireMayShare(owner, "watch.alarm", "a1")).resolves.toBeUndefined();
        await expect(requireMayShare(reader, "watch.alarm", "a1")).rejects.toThrow();
    });
});
