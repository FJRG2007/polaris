/**
 * Every way of signing an account out of everything reaches its command-line
 * sign-ins too: the owner's "sign out everywhere else", an administrator's
 * "sign out everywhere", and ending one CLI sign-in from the administrator's
 * view of the account. A terminal left signed in would be the one device the
 * press was meant to reach.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ADA = "11111111-1111-4111-8111-111111111111";
const ADMIN = "33333333-3333-4333-8333-333333333333";

const cliEnded: string[] = [];
const oneEnded: { userId: string; id: string }[] = [];
const notices: { userId: string; count: number }[] = [];

vi.mock("@/lib/cli/sessions", () => ({
    revokeCliSessions: async (userId: string) => {
        cliEnded.push(userId);
        return 2;
    },
    revokeCliSession: async (userId: string, id: string) => {
        oneEnded.push({ userId, id });
        return id === "live-key";
    }
}));
vi.mock("@/lib/extension/sessions", () => ({ revokeExtensionSessions: async () => 0 }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/notifications/session-events", () => ({
    notifySessionOpened: async () => undefined,
    notifySessionsClosed: async (entry: { userId: string; count: number }) =>
        void notices.push(entry)
}));
vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("next/headers", () => ({
    cookies: async () => ({ get: () => undefined }),
    headers: async () => new Headers()
}));
vi.mock("@/lib/network-service", () => ({ networkPublicIp: async () => null }));
vi.mock("@/lib/avatar-service", () => ({ discardAvatars: async () => undefined }));
vi.mock("@/lib/personal-drive", () => ({ discardPersonalDrive: async () => undefined }));
vi.mock("@/lib/session-guard", () => ({ revokeSessionsRefusedByRules: async () => 0 }));
vi.mock("@polaris/db", () => ({
    VISIBLE_USER: {},
    prisma: {
        session: { deleteMany: async () => ({ count: 1 }) },
        user: { count: async () => 1 }
    }
}));
vi.mock("@polaris/auth", async (original) => ({
    ...(await original<object>()),
    markPrincipalsMoved: async () => undefined
}));

const { revokeOtherSessions } = await import("@/lib/session-directory");
const { revokeCliSessionForUser, revokeUserSessions } = await import("@/lib/user-admin-service");

beforeEach(() => {
    cliEnded.length = 0;
    oneEnded.length = 0;
    notices.length = 0;
});

describe("signing out everywhere", () => {
    it("from the account's own sessions screen ends its CLI sign-ins, and counts them", async () => {
        await revokeOtherSessions(ADA, "current-session");
        expect(cliEnded).toEqual([ADA]);
        // One browser session and two terminals.
        expect(notices).toEqual([expect.objectContaining({ userId: ADA, count: 3 })]);
    });

    it("by an administrator ends them as well", async () => {
        await revokeUserSessions(ADMIN, ADA);
        expect(cliEnded).toEqual([ADA]);
        expect(notices).toEqual([expect.objectContaining({ userId: ADA, count: 3 })]);
    });
});

describe("an administrator ending one CLI sign-in", () => {
    it("revokes it and tells the account", async () => {
        expect(await revokeCliSessionForUser(ADMIN, ADA, "live-key")).toEqual({});
        expect(oneEnded).toEqual([{ userId: ADA, id: "live-key" }]);
        expect(notices).toEqual([expect.objectContaining({ userId: ADA, count: 1 })]);
    });

    it("says so when it had already ended", async () => {
        const result = await revokeCliSessionForUser(ADMIN, ADA, "gone-key");
        expect(result.error).toBeTruthy();
        expect(notices).toEqual([]);
    });
});
