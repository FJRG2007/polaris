// @vitest-environment jsdom

/**
 * The sign-in form with the password lock's kill switch thrown
 * (docs/chat-e2ee-phase1.md, "Password flows over OPAQUE"): the old password
 * route runs first and nothing is moved onto OPAQUE, but a password it refuses
 * is tried over OPAQUE before the form says it is wrong - an account whose
 * password was set over OPAQUE has no usable hash and must still get in.
 */

import { MessagesWrapper } from "../../setup/i18n";
import { freshWebStorage } from "../../helpers/memory-storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
    useRouter: () => router,
    useSearchParams: () => new URLSearchParams()
}));
const signIn = vi.hoisted(() => ({ email: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({ authClient: {}, signIn }));
vi.mock("@/lib/passkey-sign-in", () => ({ signInWithPasskeys: vi.fn() }));
const actions = vi.hoisted(() => ({
    accountHasPasskey: vi.fn(async () => false),
    automaticPasskeys: vi.fn(async () => []),
    emailLinkOffered: vi.fn(async () => false),
    passkeysFor: vi.fn(async () => []),
    resolveIdentifier: vi.fn(async (identifier: string) => identifier),
    ssoOffered: vi.fn(async () => false)
}));
vi.mock("@/app/oauth/login/actions", () => actions);
vi.mock("@/app/oauth/login/qr-panel", () => ({ QrSignInPanel: () => null }));
vi.mock("@/app/oauth/login/account-chooser", () => ({ AccountChooser: () => null }));
vi.mock("@/app/oauth/enroll/actions", () => ({ pendingEnrollmentAction: vi.fn(async () => null) }));
vi.mock("@/app/oauth/enroll/enroll-view", () => ({ EnrollView: () => null }));
vi.mock("@/app/device-account-actions", () => ({ prepareAddAccountAction: vi.fn(async () => undefined) }));
const opaque = vi.hoisted(() => ({
    signInWithOpaque: vi.fn(),
    adoptInBackground: vi.fn(async () => undefined),
    settleInBackground: vi.fn(async () => undefined)
}));
vi.mock("@/lib/chat/e2ee/sign-in-client", () => opaque);

const { LoginForm } = await import("@/app/oauth/login/login-form");

const EMAIL = "alice@example.com";
const PASSWORD = "a brand new staple 42";

async function submit(opaqueSignIn: boolean) {
    render(<LoginForm awaitingSetup={false} providers={[]} opaqueSignIn={opaqueSignIn} />, {
        wrapper: MessagesWrapper
    });
    fireEvent.change(await screen.findByPlaceholderText(/email|username|correo|usuario/i), {
        target: { value: EMAIL }
    });
    fireEvent.change(document.querySelector('input[type="password"]')!, { target: { value: PASSWORD } });
    fireEvent.submit(document.querySelector("form")!);
}

beforeEach(() => {
    freshWebStorage();
});

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe("signing in with the kill switch thrown", () => {
    it("an account with a hash signs in the old way and is not moved", async () => {
        signIn.email.mockResolvedValue({ data: {}, error: null });
        await submit(false);
        await waitFor(() => expect(router.push).toHaveBeenCalled());
        expect(signIn.email).toHaveBeenCalledWith({ email: EMAIL, password: PASSWORD });
        expect(opaque.signInWithOpaque).not.toHaveBeenCalled();
        expect(opaque.adoptInBackground).not.toHaveBeenCalled();
    });

    it("a password the old route refuses gets in over OPAQUE, with nothing moved", async () => {
        signIn.email.mockResolvedValue({ data: null, error: { status: 401, code: "INVALID_EMAIL_OR_PASSWORD" } });
        opaque.signInWithOpaque.mockResolvedValue({ challenged: false });
        await submit(false);
        await waitFor(() => expect(router.push).toHaveBeenCalled());
        expect(opaque.signInWithOpaque).toHaveBeenCalledWith(EMAIL, PASSWORD, expect.any(Function));
        expect(opaque.adoptInBackground).not.toHaveBeenCalled();
        expect(document.querySelector('[role="alert"], .text-danger')).toBeNull();
    });

    it("a second factor after the OPAQUE retry goes to the challenge", async () => {
        signIn.email.mockResolvedValue({ data: null, error: { status: 401 } });
        opaque.signInWithOpaque.mockResolvedValue({ challenged: true });
        await submit(false);
        await waitFor(() => expect(router.push).toHaveBeenCalledWith(expect.stringMatching(/^\/oauth\/2fa/)));
    });

    it("a password both refuse is wrong, and a throttle is not retried", async () => {
        signIn.email.mockResolvedValue({ data: null, error: { status: 401 } });
        opaque.signInWithOpaque.mockResolvedValue(null);
        await submit(false);
        await waitFor(() => expect(opaque.signInWithOpaque).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(document.body.textContent).toMatch(/password|contraseña/i));
        expect(router.push).not.toHaveBeenCalled();

        cleanup();
        vi.clearAllMocks();
        signIn.email.mockResolvedValue({ data: null, error: { status: 429 } });
        await submit(false);
        await waitFor(() => expect(signIn.email).toHaveBeenCalled());
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(opaque.signInWithOpaque).not.toHaveBeenCalled();
    });
});

describe("signing in with the password lock on", () => {
    it("tries OPAQUE first and moves an account the old route signed in", async () => {
        opaque.signInWithOpaque.mockResolvedValue(null);
        signIn.email.mockResolvedValue({ data: {}, error: null });
        await submit(true);
        await waitFor(() => expect(router.push).toHaveBeenCalled());
        expect(opaque.signInWithOpaque).toHaveBeenCalledTimes(1);
        expect(opaque.adoptInBackground).toHaveBeenCalledWith(EMAIL, PASSWORD, true);
    });
});
