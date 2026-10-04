/**
 * An administrator reading an account's sessions sees their own device marked.
 *
 * The list is read with the caller's own session as the "current" one: on
 * somebody else's account that matches nothing, and on the administrator's own
 * it marks the row they are reading from as "This device" - the one row on the
 * list they must not sign out by mistake.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const listUserSessions = vi.fn(async () => []);

vi.mock("@/lib/session", () => ({
    requireAdmin: vi.fn(async () => ({
        id: "admin-user",
        isAdmin: true,
        sessionId: "admin-session"
    }))
}));
vi.mock("@/lib/session-directory", () => ({ listUserSessions }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
// The rest of the module's neighbours reach the database; nothing here calls them.
vi.mock("@/lib/audit-service", () => ({}));
vi.mock("@/lib/access-live", () => ({}));
vi.mock("@/lib/setting-store", () => ({}));
vi.mock("@/lib/profile-service", () => ({}));
vi.mock("@/lib/privacy-service", () => ({}));
vi.mock("@/lib/sharing-policy", () => ({}));
vi.mock("@/lib/account-recovery-service", () => ({}));
vi.mock("@/lib/invite-service", () => ({}));
vi.mock("@/lib/user-admin-service", () => ({}));

const { userSessionsAction } = await import("@/app/(app)/admin/users/actions");

describe("an administrator's read of somebody's sessions", () => {
    beforeEach(() => listUserSessions.mockClear());

    it("is read with the administrator's own session as the current one", async () => {
        await userSessionsAction("11111111-1111-4111-8111-111111111111");
        expect(listUserSessions).toHaveBeenCalledWith(
            "11111111-1111-4111-8111-111111111111",
            "admin-session"
        );
    });

    it("reads nothing for an id that is not one", async () => {
        const result = await userSessionsAction("not-an-id");
        expect(listUserSessions).not.toHaveBeenCalled();
        expect(result.error).toBeTruthy();
    });
});
