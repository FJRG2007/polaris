/**
 * A Polar project shared with somebody (`polar.project`): listed after their
 * own projects and marked shared, never one of someone else's they hold no
 * grant on, and handed out only by its owner.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const PROJECT = "0192f0aa-0000-7000-8000-0000000000b3";

const state = vi.hoisted(() => ({ lent: [] as string[], sharedWhere: null as unknown }));

vi.mock("@polaris/db", () => ({
    prisma: {
        polarThread: { findMany: vi.fn(async () => []) },
        polarProject: {
            findMany: vi.fn(async (args: { where: { ownerId: unknown } }) => {
                if (typeof args.where.ownerId === "string") {
                    return [{ id: "own", name: "Mine", instructions: "" }];
                }
                state.sharedWhere = args.where;
                return [{ id: PROJECT, name: "Theirs", instructions: "Be brief." }];
            }),
            findUnique: vi.fn(async () => ({ ownerId: "owner" }))
        }
    }
}));
vi.mock("@/lib/access/grants", () => ({
    grantedSubjects: vi.fn(async () => new Map(state.lent.map((id) => [id, "view"]))),
    GrantError: class GrantError extends Error {}
}));
vi.mock("@/lib/session", () => ({ sessionCan: vi.fn(async () => false) }));
vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: vi.fn(async () => []) }));
vi.mock("@/lib/notes/access", () => ({ requireSpace: vi.fn(), requireNote: vi.fn() }));
vi.mock("@/lib/office/documents", () => ({ requireShareable: vi.fn() }));
vi.mock("@/lib/chat/access", () => ({ requireSpace: vi.fn(), requireChannel: vi.fn() }));
vi.mock("@/lib/tasks/access", () => ({ requireSpace: vi.fn(), requireFolder: vi.fn() }));
vi.mock("@/lib/machines/machine-access", () => ({ domainOwner: vi.fn(), lendableServer: vi.fn() }));

const { polarSidebar } = await import("@/lib/polar/threads");
const { requireMayShare, subjectHref } = await import("@/lib/access/sharing-service");

type Sharer = Parameters<typeof requireMayShare>[0];

describe("a shared Polar project", () => {
    beforeEach(() => {
        state.lent = [];
        state.sharedWhere = null;
    });

    it("is listed after the reader's own, marked shared, only through a grant", async () => {
        expect((await polarSidebar("reader")).projects).toEqual([
            { id: "own", name: "Mine", instructions: "" }
        ]);
        expect(state.sharedWhere).toBeNull();
        state.lent = [PROJECT];
        const { projects } = await polarSidebar("reader");
        expect(state.sharedWhere).toEqual({ id: { in: [PROJECT] }, ownerId: { not: "reader" } });
        expect(projects[1]).toEqual({
            id: PROJECT,
            name: "Theirs",
            instructions: "Be brief.",
            shared: true
        });
    });

    it("is handed out by its owner and by nobody else", async () => {
        const as = (id: string) => ({ id, isAdmin: true }) as Sharer;
        await expect(requireMayShare(as("reader"), "polar.project", PROJECT)).rejects.toThrow();
        await expect(
            requireMayShare(as("owner"), "polar.project", PROJECT)
        ).resolves.toBeUndefined();
        expect(subjectHref("polar.project", PROJECT)).toBe("/polar");
    });
});
