/**
 * The gate in front of the better-auth endpoints that change what protects an
 * account.
 *
 * Two rules meet here, and both exist because the ceremony behind them proves the
 * wrong thing: WebAuthn proves the device, so an open session left on a borrowed
 * screen was enough to attach a permanent way in. The password confirmation is
 * what makes adding a passkey a deliberate act, and the new-device wait is what
 * stops somebody who has just taken the password using it to lock the owner out.
 *
 * What is pinned is which requests are stopped and which are waved through. A
 * gate that refused a sign-in would be worse than no gate at all, and a gate that
 * missed one of the endpoints would read as protection that is not there.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const userSecurity = { findUnique: vi.fn(), upsert: vi.fn() };
const accountDevice = { findFirst: vi.fn(), findUnique: vi.fn() };
const session = { findFirst: vi.fn() };

vi.mock("@polaris/db", () => ({
    prisma: { userSecurity, accountDevice, session, passkey: { update: vi.fn(), findMany: vi.fn() } }
}));

const { refuseProtectedEndpoint } = await import("../../src/auth.js");

const SIGNED_IN = { user: { id: "user-1" }, session: { id: "session-1" } };

/** An auth instance that resolves whichever session the test wants. */
function authFor(resolved: unknown) {
    return { api: { getSession: async () => resolved } } as never;
}

function post(path: string): Request {
    return new Request(`https://polaris.local/api/auth${path}`, { method: "POST" });
}

/** The account settled and its password proved a moment ago. */
function readyToRegister() {
    userSecurity.findUnique.mockImplementation(async (args: { select?: Record<string, boolean> }) =>
        args.select?.reauthUntil
            ? { reauthUntil: new Date(Date.now() + 60_000), reauthSessionId: "session-1" }
            : { newDeviceGraceDays: 0 }
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    session.findFirst.mockResolvedValue({ userAgent: "Chrome", state: null });
});

describe("refuseProtectedEndpoint", () => {
    it("ignores every endpoint that does not change the account's protection", async () => {
        for (const path of [
            "/sign-in/email",
            "/passkey/generate-authenticate-options",
            "/passkey/verify-authentication",
            "/two-factor/verify-totp",
            "/get-session"
        ]) {
            expect(await refuseProtectedEndpoint(authFor(SIGNED_IN), post(path))).toBeNull();
        }
    });

    it("leaves an unauthenticated request to better-auth", async () => {
        // Answering it here would only invent a second opinion about who is
        // signed in, and better-auth refuses it anyway.
        const refusal = await refuseProtectedEndpoint(
            authFor(null),
            post("/passkey/generate-register-options")
        );
        expect(refusal).toBeNull();
    });

    it("refuses to start a registration the password has not been confirmed for", async () => {
        userSecurity.findUnique.mockImplementation(async (args: { select?: Record<string, boolean> }) =>
            args.select?.reauthUntil ? null : { newDeviceGraceDays: 0 }
        );
        const refusal = await refuseProtectedEndpoint(
            authFor(SIGNED_IN),
            post("/passkey/generate-register-options")
        );
        expect(refusal?.status).toBe(403);
        expect(await refusal?.json()).toMatchObject({ code: "PASSWORD_NOT_CONFIRMED" });
    });

    it("refuses a confirmation another session proved", async () => {
        userSecurity.findUnique.mockImplementation(async (args: { select?: Record<string, boolean> }) =>
            args.select?.reauthUntil
                ? { reauthUntil: new Date(Date.now() + 60_000), reauthSessionId: "another-session" }
                : { newDeviceGraceDays: 0 }
        );
        const refusal = await refuseProtectedEndpoint(
            authFor(SIGNED_IN),
            post("/passkey/generate-register-options")
        );
        expect(refusal?.status).toBe(403);
    });

    it("refuses a confirmation that has expired", async () => {
        userSecurity.findUnique.mockImplementation(async (args: { select?: Record<string, boolean> }) =>
            args.select?.reauthUntil
                ? { reauthUntil: new Date(Date.now() - 1_000), reauthSessionId: "session-1" }
                : { newDeviceGraceDays: 0 }
        );
        const refusal = await refuseProtectedEndpoint(
            authFor(SIGNED_IN),
            post("/passkey/generate-register-options")
        );
        expect(refusal?.status).toBe(403);
    });

    it("lets a confirmed registration through", async () => {
        readyToRegister();
        expect(
            await refuseProtectedEndpoint(authFor(SIGNED_IN), post("/passkey/generate-register-options"))
        ).toBeNull();
    });

    it("holds a device still serving the account's wait, before asking for anything else", async () => {
        userSecurity.findUnique.mockResolvedValue({ newDeviceGraceDays: 7 });
        accountDevice.findUnique.mockResolvedValue({ firstSeenAt: new Date() });
        // Some other browser opened the account, so this one is genuinely new to it
        // rather than the founding device the wait never applies to.
        accountDevice.findFirst.mockResolvedValue({ userAgent: "Some other browser" });
        for (const path of [
            "/passkey/generate-register-options",
            "/passkey/delete-passkey",
            "/passkey/update-passkey",
            "/two-factor/enable",
            "/two-factor/disable"
        ]) {
            const refusal = await refuseProtectedEndpoint(authFor(SIGNED_IN), post(path));
            expect(refusal?.status, path).toBe(403);
            expect(await refusal?.json()).toMatchObject({ code: "NEW_DEVICE_WAITING" });
        }
    });

    it("asks the settled device for nothing beyond the registration ceremony", async () => {
        // Removing a passkey and dropping the authenticator only ever take a way
        // in away; the password is what better-auth already asks for on those.
        userSecurity.findUnique.mockResolvedValue({ newDeviceGraceDays: 0 });
        for (const path of ["/passkey/delete-passkey", "/two-factor/disable"]) {
            expect(await refuseProtectedEndpoint(authFor(SIGNED_IN), post(path))).toBeNull();
        }
    });
});
