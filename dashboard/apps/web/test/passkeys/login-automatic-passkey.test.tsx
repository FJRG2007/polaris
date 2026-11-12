// @vitest-environment jsdom

/**
 * The sign-in screen asking for a passkey the moment it opens. Only for a
 * passkey this browser has itself used, only once the server says the account
 * still wants it, never while adding an account or right after signing out, and
 * a dismissed prompt leaves the screen as it was.
 */

import { MessagesWrapper } from "../setup/i18n";
import { freshWebStorage } from "../helpers/memory-storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
    useRouter: () => router,
    useSearchParams: () => new URLSearchParams()
}));
const signInWithPasskeys = vi.hoisted(() => vi.fn());
vi.mock("@/lib/passkey-sign-in", () => ({ signInWithPasskeys }));
vi.mock("@/lib/auth-client", () => ({ authClient: {}, signIn: {} }));
const actions = vi.hoisted(() => ({
    accountHasPasskey: vi.fn(async () => false),
    automaticPasskeys: vi.fn(),
    emailLinkOffered: vi.fn(async () => false),
    passkeysFor: vi.fn(async () => []),
    resolveIdentifier: vi.fn(async () => null),
    ssoOffered: vi.fn(async () => false)
}));
vi.mock("@/app/oauth/login/actions", () => actions);
vi.mock("@/app/oauth/login/qr-panel", () => ({ QrSignInPanel: () => null }));
vi.mock("@/app/oauth/login/account-chooser", () => ({ AccountChooser: () => null }));
vi.mock("@/app/oauth/enroll/actions", () => ({ pendingEnrollmentAction: vi.fn() }));
vi.mock("@/app/oauth/enroll/enroll-view", () => ({ EnrollView: () => null }));
vi.mock("@/app/device-account-actions", () => ({
    prepareAddAccountAction: vi.fn(async () => undefined)
}));

const { LoginForm } = await import("@/app/oauth/login/login-form");
const local = await import("@/lib/local-passkeys");

const HERE = { id: "aGVsbG8td2luZG93cy1oZWxsbw", authenticatorAttachment: "platform" };
const ALLOWED = [{ id: HERE.id, transports: ["internal"] }];

function open(add: Parameters<typeof LoginForm>[0]["add"] = null) {
    return render(<LoginForm awaitingSetup={false} providers={[]} add={add} />, {
        wrapper: MessagesWrapper
    });
}

let focus: typeof document.hasFocus;

beforeEach(() => {
    freshWebStorage();
    focus = document.hasFocus;
    document.hasFocus = () => true;
    actions.automaticPasskeys.mockResolvedValue(ALLOWED);
});

afterEach(() => {
    cleanup();
    document.hasFocus = focus;
    vi.clearAllMocks();
});

describe("the sign-in screen asking for a passkey as it opens", () => {
    it("asks for the passkey this browser used, and goes in when it answers", async () => {
        local.rememberLocalPasskey(HERE);
        signInWithPasskeys.mockResolvedValue({ error: null });
        open();
        await waitFor(() => expect(router.push).toHaveBeenCalled());
        expect(actions.automaticPasskeys).toHaveBeenCalledWith([HERE.id]);
        expect(signInWithPasskeys).toHaveBeenCalledWith(ALLOWED);
    });

    it("asks nothing, not even the server, on a browser that has used no passkey here", async () => {
        open();
        await screen.findByPlaceholderText(/email|username|correo|usuario/i);
        expect(actions.automaticPasskeys).not.toHaveBeenCalled();
        expect(signInWithPasskeys).not.toHaveBeenCalled();
    });

    it("raises no prompt when the server says the account turned it off", async () => {
        local.rememberLocalPasskey(HERE);
        actions.automaticPasskeys.mockResolvedValue([]);
        open();
        await waitFor(() => expect(actions.automaticPasskeys).toHaveBeenCalled());
        expect(signInWithPasskeys).not.toHaveBeenCalled();
    });

    it("waits for the button while adding another account", async () => {
        local.rememberLocalPasskey(HERE);
        open({ name: "Ana", full: false, max: 5 } as Parameters<typeof LoginForm>[0]["add"]);
        await screen.findByPlaceholderText(/email|username|correo|usuario/i);
        expect(actions.automaticPasskeys).not.toHaveBeenCalled();
    });

    it("waits for the button right after a deliberate sign-out", async () => {
        local.rememberLocalPasskey(HERE);
        local.pauseAutomaticPasskey();
        open();
        await screen.findByPlaceholderText(/email|username|correo|usuario/i);
        expect(actions.automaticPasskeys).not.toHaveBeenCalled();
    });

    it("leaves the screen as it was when the prompt is dismissed", async () => {
        local.rememberLocalPasskey(HERE);
        signInWithPasskeys.mockResolvedValue({ error: { code: "AUTH_CANCELLED" } });
        open();
        await waitFor(() => expect(local.automaticPasskeyPaused()).toBe(true));
        expect(router.push).not.toHaveBeenCalled();
        expect(document.querySelector(".text-danger")).toBeNull();
    });
});
