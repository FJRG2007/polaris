/**
 * Looking at Polaris as somebody else, from the resolution side.
 *
 * Four properties hold this feature up. A view lives on the administrator's own
 * session, so the account being looked at never gets one of its own. A role
 * preview takes the administrator's admin flag away, or every screen would answer
 * "yes" and the preview would be a lie. A view that has lapsed, or that points at
 * something since deleted, puts the session back to being itself instead of
 * failing the request. And the wildcard role previews as every permission, not as
 * an empty role.
 */

import { ALL_PERMISSIONS, PERMISSIONS } from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const users = [
    { id: "admin-1", email: "root@example.com", name: "Root", image: null, isAdmin: true },
    { id: "user-2", email: "ada@example.com", name: "Ada", image: null, isAdmin: false }
];
const roles = [
    { id: "role-guest", name: "guest", permissions: "[]" },
    { id: "role-viewer", name: "viewer", permissions: JSON.stringify(["drive.read", "tasks.read"]) },
    { id: "role-admin", name: "admin", permissions: JSON.stringify([ALL_PERMISSIONS]) }
];

/** The sessions the fake database holds, keyed by id, so a clear is observable. */
let sessions: Record<string, { viewAsUserId: string | null; viewAsRoleId: string | null; viewAsAt: Date | null }> = {};

vi.mock("@polaris/db", () => ({
    prisma: {
        user: {
            findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
                users.find((user) => user.id === where.id) ?? null
            )
        },
        role: {
            findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
                roles.find((role) => role.id === where.id) ?? null
            )
        },
        sessionState: {
            updateMany: vi.fn(async ({ where, data }: { where: { sessionId: string }; data: object }) => {
                const row = sessions[where.sessionId];
                if (!row) return { count: 0 };
                Object.assign(row, data);
                return { count: 1 };
            }),
            // A copy, as a real read returns: the caller holds a snapshot, not a
            // handle that a later write mutates underneath it.
            findUnique: vi.fn(async ({ where }: { where: { sessionId: string } }) => {
                const row = sessions[where.sessionId];
                return row ? { ...row } : null;
            })
        }
    }
}));

const recordAudit = vi.fn(async () => {});
vi.mock("@/lib/audit-service", () => ({ recordAudit }));

const { resolveViewAs, stopViewAs, viewAsRole, viewAsUser } = await import("@/lib/view-as-service");

const ACTOR = { id: "admin-1", name: "Root", sessionId: "session-1" };

beforeEach(() => {
    sessions = { "session-1": { viewAsUserId: null, viewAsRoleId: null, viewAsAt: null } };
    recordAudit.mockClear();
});

describe("viewing another account", () => {
    it("records the view on the administrator's own session, and nowhere else", async () => {
        expect(await viewAsUser(ACTOR, "user-2")).toEqual({});
        expect(sessions["session-1"]).toMatchObject({ viewAsUserId: "user-2", viewAsRoleId: null });
        // Nothing was written against the account being looked at.
        expect(Object.keys(sessions)).toEqual(["session-1"]);
    });

    it("resolves to that account's identity, keeping the administrator on the record", async () => {
        await viewAsUser(ACTOR, "user-2");
        const view = await resolveViewAs(ACTOR, sessions["session-1"]!);
        expect(view?.mode).toBe("user");
        expect(view?.user).toMatchObject({ id: "user-2", name: "Ada", isAdmin: false });
        expect(view?.actorId).toBe("admin-1");
        expect(view?.label).toBe("Ada");
    });

    it("refuses your own account and an account that is not there", async () => {
        expect((await viewAsUser(ACTOR, "admin-1")).error).toBe("That is already your account.");
        expect((await viewAsUser(ACTOR, "nobody")).error).toBe("User not found.");
    });

    it("writes both ends of the episode to the audit log", async () => {
        await viewAsUser(ACTOR, "user-2");
        await stopViewAs(ACTOR);
        const actions = recordAudit.mock.calls.map(([entry]) => (entry as { action: string }).action);
        expect(actions).toEqual(["user.view-as.start", "user.view-as.stop"]);
        expect(sessions["session-1"]).toMatchObject({ viewAsUserId: null, viewAsAt: null });
    });
});

describe("previewing a role", () => {
    it("keeps the administrator's identity and stands the role's grants in", async () => {
        await viewAsRole(ACTOR, "role-viewer");
        const view = await resolveViewAs(ACTOR, sessions["session-1"]!);
        expect(view?.mode).toBe("role");
        expect(view?.user).toBeUndefined();
        expect(view?.grants).toEqual(["drive.read", "tasks.read"]);
    });

    it("previews a role that grants nothing as granting nothing", async () => {
        await viewAsRole(ACTOR, "role-guest");
        expect((await resolveViewAs(ACTOR, sessions["session-1"]!))?.grants).toEqual([]);
    });

    it("writes the wildcard out in full, so the admin role previews as itself", async () => {
        await viewAsRole(ACTOR, "role-admin");
        expect((await resolveViewAs(ACTOR, sessions["session-1"]!))?.grants).toEqual([...PERMISSIONS]);
    });

    it("replaces an account view rather than stacking on it", async () => {
        await viewAsUser(ACTOR, "user-2");
        await viewAsRole(ACTOR, "role-viewer");
        expect(sessions["session-1"]).toMatchObject({ viewAsUserId: null, viewAsRoleId: "role-viewer" });
    });
});

describe("a view that should no longer apply", () => {
    it("lapses after its ceiling and puts the session back to itself", async () => {
        await viewAsUser(ACTOR, "user-2");
        sessions["session-1"]!.viewAsAt = new Date(Date.now() - 61 * 60 * 1000);
        expect(await resolveViewAs(ACTOR, sessions["session-1"]!)).toBeNull();
        expect(sessions["session-1"]).toMatchObject({ viewAsUserId: null, viewAsAt: null });
    });

    it("clears itself when the account it points at is gone", async () => {
        sessions["session-1"] = { viewAsUserId: "deleted", viewAsRoleId: null, viewAsAt: new Date() };
        expect(await resolveViewAs(ACTOR, sessions["session-1"]!)).toBeNull();
        expect(sessions["session-1"]).toMatchObject({ viewAsUserId: null });
    });

    it("clears itself when the role it points at is gone", async () => {
        sessions["session-1"] = { viewAsUserId: null, viewAsRoleId: "deleted", viewAsAt: new Date() };
        expect(await resolveViewAs(ACTOR, sessions["session-1"]!)).toBeNull();
        expect(sessions["session-1"]).toMatchObject({ viewAsRoleId: null });
    });

    it("resolves to nothing on a session that is simply itself", async () => {
        expect(await resolveViewAs(ACTOR, sessions["session-1"]!)).toBeNull();
    });
});
