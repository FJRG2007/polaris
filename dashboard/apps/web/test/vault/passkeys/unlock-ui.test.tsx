// @vitest-environment jsdom

/**
 * The passkey option on the lock screen: offered only when the browser can
 * evaluate PRF, and replaced by the reason when it cannot - never a button that
 * cannot work.
 */

import * as core from "@polaris/core";
import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VaultPasskeyEntry } from "@/lib/vault/passkey-schema";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const support = vi.hoisted(() => vi.fn());
vi.mock("@/lib/vault/passkey-client", async (original) => ({
    ...(await original<typeof import("@/lib/vault/passkey-client")>()),
    passkeySupport: () => support()
}));
vi.mock("@/app/(app)/vault/passkey-actions", () => ({
    vaultPasskeyUsedAction: vi.fn(async () => undefined),
    enrollVaultPasskeyAction: vi.fn(),
    removeVaultPasskeyAction: vi.fn(),
    vaultPasskeyCandidatesAction: vi.fn(async () => [])
}));
/** One object, as the real provider hands out: a fresh one per render would
 *  be a session that changes on every draw. */
const session = vi.hoisted(() => ({
    state: { email: "ana@example.com", kdf: {}, protectedKey: "2.a|b|c", passkeys: [] },
    key: null
}));
vi.mock("@/app/(app)/vault/vault-session", () => ({ useVaultSession: () => session }));

const { VaultUnlock } = await import("@/app/(app)/vault/vault-unlock");
const { VaultPasskeys } = await import("@/app/(app)/vault/settings/vault-passkeys");

const ENTRY: VaultPasskeyEntry = {
    id: "0190a000-0000-7000-8000-000000000001",
    name: "Phone",
    credentialId: "AQEBAQEBAQEBAQEBAQEBAQEB",
    rpId: "localhost",
    prfSalt: "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=",
    wrappedKey: "2.a|b|c",
    createdAt: "2026-10-01T00:00:00.000Z",
    lastUsedAt: null
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

describe("adding a passkey in settings", () => {
    const confirm = async () => true;

    it("offers the form when PRF works", async () => {
        support.mockResolvedValue("supported");
        render(<VaultPasskeys confirm={confirm} />, { wrapper: MessagesWrapper });
        expect(await screen.findByRole("button", { name: /add passkey/i })).toBeTruthy();
    });

    it("says why instead of offering it when PRF does not", async () => {
        support.mockResolvedValue("no-prf");
        render(<VaultPasskeys confirm={confirm} />, { wrapper: MessagesWrapper });
        expect(await screen.findByTestId("passkey-unavailable")).toBeTruthy();
        expect(screen.queryByRole("button", { name: /add passkey/i })).toBeNull();
    });
});
