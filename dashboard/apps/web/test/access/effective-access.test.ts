/**
 * The capability answers given to code that only holds a user id - which is where
 * a role preview would otherwise leak.
 *
 * An administrator previewing the guest role is still, in the database, an
 * administrator. Every check that reaches for the account behind the id would say
 * yes, and Drive would sit there wide open while the banner claimed otherwise.
 * So the preview has to win over both the admin bypass and the account's own
 * grants - and only for the administrator running it, never for the account they
 * are acting as, whose own access is the whole point.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let view: { viewAsUserId: string | null; viewAsRoleId: string | null; viewAsAt: Date | null } = {
    viewAsUserId: null,
    viewAsRoleId: null,
    viewAsAt: null
};

const userHasPermission = vi.fn(async () => true);

vi.mock("@polaris/db", () => ({
    prisma: { sessionState: { findUnique: vi.fn(async () => ({ ...view })) } }
}));
vi.mock("@polaris/auth", () => ({ userHasPermission }));
vi.mock("@/lib/session", () => ({
    resolveSession: vi.fn(async () => ({ id: "admin-1", name: "Root", sessionId: "session-1" }))
}));
vi.mock("@/lib/view-as-service", () => ({
    resolveViewAs: vi.fn(async () => (view.viewAsRoleId ? { mode: "role", grants: ["drive.read"] } : null))
}));

const { effectiveCan, effectiveIsAdmin } = await import("@/lib/effective-access");

beforeEach(() => {
    view = { viewAsUserId: null, viewAsRoleId: null, viewAsAt: null };
    userHasPermission.mockClear();
    vi.resetModules();
});

describe("with nothing being previewed", () => {
    it("leaves the administrator flag alone", async () => {
        expect(await effectiveIsAdmin("admin-1", true)).toBe(true);
    });

    it("answers from the account's own grants", async () => {
        expect(await effectiveCan("admin-1", "drive.write")).toBe(true);
        expect(userHasPermission).toHaveBeenCalledWith("admin-1", "drive.write");
    });
});

describe("while a role is being previewed", () => {
    beforeEach(() => {
        view = { viewAsUserId: null, viewAsRoleId: "role-viewer", viewAsAt: new Date() };
    });

    it("takes the administrator bypass away", async () => {
        expect(await effectiveIsAdmin("admin-1", true)).toBe(false);
    });

    it("answers from the previewed role, not the account", async () => {
        expect(await effectiveCan("admin-1", "drive.read")).toBe(true);
        expect(await effectiveCan("admin-1", "drive.write")).toBe(false);
        // The account's own grants were never consulted.
        expect(userHasPermission).not.toHaveBeenCalled();
    });

    it("leaves everybody else's answers untouched", async () => {
        expect(await effectiveIsAdmin("user-2", true)).toBe(true);
        expect(await effectiveCan("user-2", "drive.write")).toBe(true);
    });
});
