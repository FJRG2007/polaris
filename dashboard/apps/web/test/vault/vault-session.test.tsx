// @vitest-environment jsdom

/**
 * One unlocked vault, held across every vault screen.
 *
 * Before this, each vault screen unlocked on its own, so moving from the item
 * list to Sends asked for the master password again. What is pinned here is the
 * deal that replaced it: the key survives a remount of the provider (which is
 * what moving between screens actually does to it), a deadline written beside
 * the key - not a running timer - is what makes it survive the tab sitting in
 * the background, activity pushes that deadline out, and "as soon as I leave
 * the vault" never touches storage at all.
 */

import * as core from "@polaris/core";
import * as vaultCrypto from "@/lib/vault/crypto";
import { useVaultSession } from "@/app/(app)/vault/vault-session";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/(app)/vault/vault-actions", () => ({ createAccountVaultAction: vi.fn() }));
vi.mock("@/app/(app)/vault/share-actions", () => ({
    vaultListAction: vi.fn(async () => [])
}));

const { VaultSessionProvider } = await import("@/app/(app)/vault/vault-session");

const STORAGE_KEY = "polaris.vault.session";

function baseState(unlockTimeout: number) {
    return {
        exists: true,
        kdf: core.DEFAULT_KDF_SETTINGS,
        protectedKey: "protected",
        privateKey: null,
        publicKey: null,
        email: "ana@example.com",
        unlockTimeout
    };
}

/** Exposes the session so the test can read and drive it through the DOM,
 *  the way a real vault screen would. */
function Probe() {
    const session = useVaultSession();
    return (
        <div>
            <span data-testid="locked">{session.key ? "unlocked" : "locked"}</span>
            <button onClick={() => session.hold(vaultCrypto.generateSymmetricKey())}>unlock</button>
        </div>
    );
}

beforeEach(() => {
    vi.useFakeTimers();
    window.sessionStorage.clear();
});

afterEach(() => {
    vi.useRealTimers();
    cleanup();
});

describe("VaultSessionProvider", () => {
    it("keeps the key in memory across a remount, the way moving between vault screens does", () => {
        const { unmount } = render(
            <VaultSessionProvider state={baseState(15)} name="Ana">
                <Probe />
            </VaultSessionProvider>
        );
        act(() => screen.getByRole("button", { name: "unlock" }).click());
        expect(screen.getByTestId("locked").textContent).toBe("unlocked");
        unmount();

        // A fresh mount is what a navigation to another vault screen looks like:
        // a new VaultSessionProvider, reading whatever survived in storage.
        render(
            <VaultSessionProvider state={baseState(15)} name="Ana">
                <Probe />
            </VaultSessionProvider>
        );
        expect(screen.getByTestId("locked").textContent).toBe("unlocked");
    });

    it("locks itself once the idle deadline passes, without waiting for a navigation", () => {
        render(
            <VaultSessionProvider state={baseState(1)} name="Ana">
                <Probe />
            </VaultSessionProvider>
        );
        act(() => screen.getByRole("button", { name: "unlock" }).click());
        expect(screen.getByTestId("locked").textContent).toBe("unlocked");

        // Just under a minute: still open.
        act(() => void vi.advanceTimersByTime(50_000));
        expect(screen.getByTestId("locked").textContent).toBe("unlocked");

        // Past it, and past the next sweep: locked, with nothing left to restore.
        act(() => void vi.advanceTimersByTime(20_000));
        expect(screen.getByTestId("locked").textContent).toBe("locked");
        expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it("pushes the deadline out on activity, so a vault in active use does not lock under somebody", () => {
        render(
            <VaultSessionProvider state={baseState(1)} name="Ana">
                <Probe />
            </VaultSessionProvider>
        );
        act(() => screen.getByRole("button", { name: "unlock" }).click());

        // Just shy of the deadline, a keystroke - the same event a form field
        // sees - resets it.
        act(() => void vi.advanceTimersByTime(50_000));
        act(() => window.dispatchEvent(new KeyboardEvent("keydown")));

        // Old deadline would have passed by now; the reset one has not.
        act(() => void vi.advanceTimersByTime(50_000));
        expect(screen.getByTestId("locked").textContent).toBe("unlocked");
    });

    it("never writes the key to storage when the setting is to lock on leaving", () => {
        render(
            <VaultSessionProvider state={baseState(core.VAULT_LOCK_IMMEDIATELY)} name="Ana">
                <Probe />
            </VaultSessionProvider>
        );
        act(() => screen.getByRole("button", { name: "unlock" }).click());
        expect(screen.getByTestId("locked").textContent).toBe("unlocked");
        expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it("holds the key until the tab closes when the setting says so, with no deadline to sweep", () => {
        render(
            <VaultSessionProvider state={baseState(core.VAULT_LOCK_ON_TAB_CLOSE)} name="Ana">
                <Probe />
            </VaultSessionProvider>
        );
        act(() => screen.getByRole("button", { name: "unlock" }).click());

        act(() => void vi.advanceTimersByTime(24 * 60 * 60_000));
        expect(screen.getByTestId("locked").textContent).toBe("unlocked");
        expect(window.sessionStorage.getItem(STORAGE_KEY)).not.toBeNull();
    });
});
