/**
 * The caller of a stream, a poll or a beacon.
 *
 * Those routes used to read the raw session, which skipped every control the
 * guard applies: a sign-in still waiting for another device's approval, a
 * locked screen, a refused address, a second factor the instance demands. A
 * session in any of those states could still export a document, read the mail
 * rail and follow the notification feed. So what is asserted here is that the
 * background caller gets the guard's verdict like every other caller - and that
 * it asks the guard not to count the request as somebody being here, or a tab
 * left open would keep the idle lock from ever closing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();
const guardSession = vi.fn();

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/session-guard", () => ({
    guardSession,
    ENROLL_PATH: "/oauth/enroll",
    SECURITY_KEY_PATH: "/oauth/security-key"
}));
vi.mock("@/lib/view-as-service", () => ({ resolveViewAs: async () => null }));
vi.mock("@/lib/apps/install-presence", () => ({ isAppInstalled: async () => true }));
vi.mock("@polaris/auth", () => ({ canAny: vi.fn(), userHasPermission: vi.fn() }));

const { backgroundUser, guardedUser, passwordGateSession } = await import("@/lib/session");

const SIGNED_IN = {
    user: { id: "u1", email: "user@example.com", name: "User", isAdmin: false },
    session: { id: "s1", createdAt: new Date("2026-01-01T00:00:00Z").toISOString() }
};

beforeEach(() => {
    vi.clearAllMocks();
    getSession.mockResolvedValue(SIGNED_IN);
});

describe("a session the guard refuses", () => {
    for (const redirect of [
        "/oauth/pending",
        "/oauth/lock",
        "/oauth/enroll",
        "/oauth/login?blocked=1"
    ]) {
        it(`is nobody to a background route (${redirect})`, async () => {
            guardSession.mockResolvedValue({ ok: false, redirect });
            expect(await backgroundUser()).toBeNull();
        });
    }
});

describe("a session the guard clears", () => {
    beforeEach(() =>
        guardSession.mockResolvedValue({
            ok: true,
            view: { viewAsUserId: null, viewAsRoleId: null, viewAsAt: null }
        })
    );

    it("is the account behind it", async () => {
        expect(await backgroundUser()).toMatchObject({ id: "u1", sessionId: "s1", isAdmin: false });
    });

    it("does not count a background request as somebody being here", async () => {
        await backgroundUser();
        expect(guardSession).toHaveBeenCalledWith(
            expect.objectContaining({ sessionId: "s1", touch: false })
        );
    });

    it("still counts an ordinary guarded request", async () => {
        await guardedUser();
        expect(guardSession).toHaveBeenCalledWith(expect.not.objectContaining({ touch: false }));
    });
});

describe("no session at all", () => {
    it("never reaches the guard", async () => {
        getSession.mockResolvedValue(null);
        expect(await backgroundUser()).toBeNull();
        expect(guardSession).not.toHaveBeenCalled();
    });
});

describe("the session a password gate's own proof start may use", () => {
    for (const redirect of ["/oauth/lock", "/oauth/enroll", "/oauth/security-key"]) {
        it(`is the real session at a gate that checks the password (${redirect})`, async () => {
            guardSession.mockResolvedValue({ ok: false, redirect });
            expect(await passwordGateSession()).toMatchObject({ id: "u1", sessionId: "s1" });
            expect(guardSession).toHaveBeenCalledWith(expect.objectContaining({ touch: false }));
        });
    }

    for (const redirect of [
        "/oauth/login?banned=1",
        "/oauth/login?lockdown=1",
        "/oauth/login?blocked=1",
        "/oauth/login?compromised=1",
        "/oauth/login?denied=1",
        "/oauth/pending",
        "/oauth/step-up",
        "/oauth/change-password",
        "/oauth/login"
    ]) {
        it(`is nobody for every other refusal (${redirect})`, async () => {
            guardSession.mockResolvedValue({ ok: false, redirect });
            expect(await passwordGateSession()).toBeNull();
        });
    }

    it("is nobody without a session", async () => {
        getSession.mockResolvedValue(null);
        expect(await passwordGateSession()).toBeNull();
    });
});
