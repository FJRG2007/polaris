// @vitest-environment jsdom

/**
 * The passkey option on the lock screen: offered only when the browser can
 * evaluate PRF, and replaced by the reason when it cannot - never a button that
 * cannot work. And the settings card: the account's own passkeys under their
 * own names, each with a switch, and nothing that reads as making a new one.
 */

import * as core from "@polaris/core";
import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VaultPasskeyChoice, VaultPasskeyEntry } from "@/lib/vault/passkey-schema";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const support = vi.hoisted(() => vi.fn());
const enrollWithPasskey = vi.hoisted(() => vi.fn());
vi.mock("@/lib/vault/passkey-client", async (original) => ({
    ...(await original<typeof import("@/lib/vault/passkey-client")>()),
    passkeySupport: () => support(),
    enrollWithPasskey
}));
const actions = vi.hoisted(() => ({
    vaultPasskeyUsedAction: vi.fn(async () => undefined),
    enrollVaultPasskeyAction: vi.fn(),
    removeVaultPasskeyAction: vi.fn(),
    vaultPasskeyChoicesAction: vi.fn()
}));
vi.mock("@/app/(app)/vault/passkey-actions", () => actions);
const stepUp = vi.hoisted(() => ({
    stepUpRemainingAction: vi.fn(),
    proveStepUpAction: vi.fn(),
    stepUpOptionsAction: vi.fn(async () => ({ choices: [] })),
    sendStepUpCodeAction: vi.fn()
}));
vi.mock("@/app/(app)/account/step-up-actions", () => stepUp);
/** One object, as the real provider hands out: a fresh one per render would
 *  be a session that changes on every draw. */
const session = vi.hoisted(() => ({
    state: { email: "ana@example.com", kdf: {}, protectedKey: "2.a|b|c", passkeys: [] },
    key: { encKey: new Uint8Array(32), macKey: new Uint8Array(32) }
}));
vi.mock("@/app/(app)/vault/vault-session", () => ({ useVaultSession: () => session }));

const { VaultUnlock } = await import("@/app/(app)/vault/vault-unlock");
const { VaultPasskeys } = await import("@/app/(app)/vault/settings/vault-passkeys");

const ENTRY: VaultPasskeyEntry = {
    id: "0190a000-0000-7000-8000-000000000001",
    credentialId: "AQEBAQEBAQEBAQEBAQEBAQEB",
    rpId: "localhost",
    prfSalt: "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=",
    wrappedKey: "2.a|b|c"
};

const CHOICE: VaultPasskeyChoice = {
    passkeyId: "0190a000-0000-7000-8000-0000000000aa",
    name: "Work laptop",
    deviceType: "singleDevice",
    addedAt: "2026-10-01T00:00:00.000Z",
    credentialId: "AgICAgICAgICAgICAgICAgIC",
    rpId: "localhost",
    vault: null
};

function lockScreen(passkeys?: VaultPasskeyEntry[]) {
    return render(
        <VaultUnlock
            email="ana@example.com"
            kdf={core.DEFAULT_KDF_SETTINGS}
            protectedKey="2.a|b|c"
            passkeys={passkeys}
            onUnlocked={() => undefined}
        />,
        { wrapper: MessagesWrapper }
    );
}

afterEach(() => {
    cleanup();
    support.mockReset();
    vi.clearAllMocks();
});

describe("unlock with a passkey", () => {
    it("is offered when a passkey is enrolled for this address and PRF works", async () => {
        support.mockResolvedValue("supported");
        lockScreen([ENTRY]);
        expect(await screen.findByRole("button", { name: /passkey/i })).toBeTruthy();
    });

    it("is replaced by the reason when this browser has no PRF", async () => {
        support.mockResolvedValue("no-prf");
        lockScreen([ENTRY]);
        expect(await screen.findByTestId("passkey-unavailable")).toBeTruthy();
        expect(screen.queryByRole("button", { name: /passkey/i })).toBeNull();
    });

    it("is not drawn without an enrolled passkey for this address", async () => {
        support.mockResolvedValue("supported");
        lockScreen([{ ...ENTRY, rpId: "other.example.test" }]);
        await waitFor(() => expect(support).toHaveBeenCalled());
        expect(screen.queryByRole("button", { name: /passkey/i })).toBeNull();
        expect(screen.queryByTestId("passkey-unavailable")).toBeNull();
    });
});

describe("the passkeys card in settings", () => {
    beforeEach(() => {
        support.mockResolvedValue("supported");
        stepUp.stepUpRemainingAction.mockResolvedValue({ remainingMs: 0 });
        actions.vaultPasskeyChoicesAction.mockResolvedValue([CHOICE]);
    });

    it("lists the account's passkeys by their own names, with no field to make one", async () => {
        render(<VaultPasskeys />, { wrapper: MessagesWrapper });
        expect(await screen.findByText("Work laptop")).toBeTruthy();
        expect(
            screen.getByRole("switch", { name: /unlock the vault with work laptop/i })
        ).toBeTruthy();
        expect(screen.queryByRole("textbox")).toBeNull();
        expect(document.querySelector("input[type=password]")).toBeNull();
        expect(screen.queryByRole("button", { name: /add passkey/i })).toBeNull();
    });

    it("names an unnamed passkey by its kind and the day it was added", async () => {
        actions.vaultPasskeyChoicesAction.mockResolvedValue([
            { ...CHOICE, name: null, deviceType: "multiDevice" }
        ]);
        render(<VaultPasskeys />, { wrapper: MessagesWrapper });
        expect(await screen.findByText(/^Synced passkey from /)).toBeTruthy();
    });

    it("sends an account without passkeys to account security", async () => {
        actions.vaultPasskeyChoicesAction.mockResolvedValue([]);
        render(<VaultPasskeys />, { wrapper: MessagesWrapper });
        await screen.findByTestId("passkey-none");
        const link = screen.getByRole("link", { name: /security/i });
        expect(link.getAttribute("href")).toBe("/account/security");
        expect(screen.queryByRole("switch")).toBeNull();
    });

    it("says why, and keeps the switch off, when this browser has no PRF", async () => {
        support.mockResolvedValue("no-prf");
        render(<VaultPasskeys />, { wrapper: MessagesWrapper });
        expect(await screen.findByTestId("passkey-unavailable")).toBeTruthy();
        const toggle = await screen.findByRole("switch");
        expect((toggle as HTMLButtonElement).disabled).toBe(true);
    });

    it("asks for the step-up proof, not the master password, before turning one on", async () => {
        render(<VaultPasskeys />, { wrapper: MessagesWrapper });
        await waitFor(() => expect(stepUp.stepUpRemainingAction).toHaveBeenCalled());
        fireEvent.click(await screen.findByRole("switch"));
        expect(await screen.findByRole("dialog")).toBeTruthy();
        expect(enrollWithPasskey).not.toHaveBeenCalled();
    });

    it("runs the ceremony with that one passkey when this session already proved itself", async () => {
        stepUp.stepUpRemainingAction.mockResolvedValue({ remainingMs: 60_000 });
        const enrollment = { credentialId: CHOICE.credentialId, prfSalt: "s", wrappedKey: "w" };
        enrollWithPasskey.mockResolvedValue({ enrollment });
        actions.enrollVaultPasskeyAction.mockResolvedValue({});
        render(<VaultPasskeys />, { wrapper: MessagesWrapper });
        await waitFor(() => expect(stepUp.stepUpRemainingAction).toHaveBeenCalled());
        const toggle = await screen.findByRole("switch");
        // Let the remaining-proof answer land before the switch is pressed.
        await act(async () => undefined);
        fireEvent.click(toggle);
        await waitFor(() => expect(enrollWithPasskey).toHaveBeenCalled());
        expect(enrollWithPasskey).toHaveBeenCalledWith({
            vaultKey: session.key,
            credentialId: CHOICE.credentialId
        });
        await waitFor(() =>
            expect(actions.enrollVaultPasskeyAction).toHaveBeenCalledWith(enrollment)
        );
        expect(screen.queryByRole("dialog")).toBeNull();
    });
});
