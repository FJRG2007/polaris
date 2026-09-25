/**
 * Unlocking through the worker itself, not only through `openVault`.
 *
 * `openVault` was always right: given the password, the address and the wrapped
 * key, it opened the vault. What reached somebody was the worker around it, and
 * the worker threw the key away again before answering. A vault that locks itself
 * leaves its deadline behind in session storage - `vault()` drops the key when the
 * deadline passes and never cleared the deadline - and the password unlock set the
 * key without arming a new one. The next thing the same answer did was ask
 * `vault()` whether it was open, find the old deadline already past, and lock it.
 * The popup got `ok: true` with a status that still said locked, so it showed
 * "Vault locked" again with no error at all: the correct master password, taken
 * and silently refused. "Let me in from Polaris" worked, because the approval
 * path did arm a deadline.
 *
 * So this drives the real message listener against a fake browser, with the
 * storage a self-locked vault really leaves: keys held, deadline in the past.
 */

import { fakeBrowser } from "wxt/testing/fake-browser";
import { createVaultKeys } from "@polaris/vault-crypto";
import type { Reply, Request } from "../src/lib/messages";
import { KDF_PBKDF2, type KdfSettings } from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const EMAIL = "javier@example.com";
const PASSWORD = "the master password";
const ORIGIN = "https://polaris.example";

/** Far below a real vault's cost: this is about the worker, not the derivation. */
const PBKDF2: KdfSettings = {
    kdf: KDF_PBKDF2,
    kdfIterations: 1000,
    kdfMemory: null,
    kdfParallelism: null
};

/** Ask the worker the way the popup does: from no tab, with this extension's id,
 *  answered through `sendResponse`. */
async function ask(request: Request): Promise<Reply> {
    let answer: (reply: Reply) => void = () => {};
    const replied = new Promise<Reply>((resolve) => (answer = resolve));
    const held = await fakeBrowser.runtime.onMessage.trigger(
        request,
        { id: fakeBrowser.runtime.id },
        answer
    );
    expect(held).toContain(true);
    return replied;
}

function unlocked(reply: Reply): boolean | undefined {
    return reply.ok && "status" in reply ? reply.status.unlocked : undefined;
}

/**
 * A browser that was let in, whose vault then locked itself: the wrapped keys and
 * the address still held, a live session, and the deadline that ran out.
 */
async function lockedByItself(lockAt: number | null): Promise<void> {
    const { keys } = await createVaultKeys(PASSWORD, EMAIL, PBKDF2);
    await fakeBrowser.storage.local.set({
        "server.origin": ORIGIN,
        "vault.email": EMAIL,
        "link.token": "connection-token"
    });
    await fakeBrowser.storage.session.set({
        "vault.refresh": "refresh-token",
        // Live, so nothing here tries to trade the refresh token - the server
        // is not the thing under test.
        "vault.access": { token: "access-token", expiresAt: Date.now() + 3_600_000 },
        "vault.wrapped": {
            key: keys.protectedKey,
            privateKey: keys.encryptedPrivateKey,
            kdf: PBKDF2
        },
        "vault.lockAt": lockAt
    });
}

beforeEach(async () => {
    fakeBrowser.reset();
    vi.resetModules();
    // Every call to the server fails, as it would from a machine that cannot
    // reach it: unlocking needs no network, and must not wait for one.
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    // The worker's listener is registered when the module is evaluated.
    await import("../src/entrypoints/background");
});

describe("unlocking with the master password, through the worker", () => {
    it("stays open after a vault that locked itself is unlocked", async () => {
        await lockedByItself(Date.now() - 60_000);

        const reply = await ask({ kind: "unlock", password: PASSWORD });

        expect(reply.ok).toBe(true);
        expect(unlocked(reply)).toBe(true);
        // And the next look finds it open too: the popup redraws from `status`.
        expect(unlocked(await ask({ kind: "status" }))).toBe(true);
    });

    it("opens a vault that never had a deadline", async () => {
        await lockedByItself(null);

        expect(unlocked(await ask({ kind: "unlock", password: PASSWORD }))).toBe(true);
    });

    it("still refuses a wrong password, in words", async () => {
        await lockedByItself(Date.now() - 60_000);

        const reply = await ask({ kind: "unlock", password: "not the master password" });

        expect(reply).toEqual({ ok: false, error: "That password did not open the vault." });
        expect(unlocked(await ask({ kind: "status" }))).toBe(false);
    });

    it("locks again when the new deadline passes", async () => {
        await lockedByItself(Date.now() - 60_000);
        await ask({ kind: "unlock", password: PASSWORD });

        const { "vault.lockAt": lockAt } = await fakeBrowser.storage.session.get("vault.lockAt");
        expect(typeof lockAt).toBe("number");
        expect(lockAt as number).toBeGreaterThan(Date.now());

        await fakeBrowser.storage.session.set({ "vault.lockAt": Date.now() - 1 });
        expect(unlocked(await ask({ kind: "status" }))).toBe(false);
    });
});

describe("unlocking from the popup opened in a tab", () => {
    /** The page somebody was on, and the popup's tab opened in front of it. */
    async function popupTab(): Promise<{ page: number; popup: number; url: string }> {
        const page = await fakeBrowser.tabs.create({ url: "https://site.example/login" });
        const url = fakeBrowser.runtime.getURL("/popup.html");
        const popup = await fakeBrowser.tabs.create({ url, active: true });
        await fakeBrowser.storage.session.set({
            "vault.unlockTab": { tabId: popup.id, returnTo: page.id }
        });
        return { page: page.id!, popup: popup.id!, url };
    }

    async function askFromTab(request: Request, tabId: number, url: string): Promise<Reply> {
        let answer: (reply: Reply) => void = () => {};
        const replied = new Promise<Reply>((resolve) => (answer = resolve));
        const tab = await fakeBrowser.tabs.get(tabId);
        await fakeBrowser.runtime.onMessage.trigger(
            request,
            { id: fakeBrowser.runtime.id, tab, url },
            answer
        );
        return replied;
    }

    it("closes that tab and goes back to the page it came from", async () => {
        await lockedByItself(null);
        const { page, popup, url } = await popupTab();

        expect(unlocked(await askFromTab({ kind: "unlock", password: PASSWORD }, popup, url))).toBe(
            true
        );

        await vi.waitFor(async () => {
            expect(await fakeBrowser.tabs.get(popup).catch(() => undefined)).toBeUndefined();
        });
        expect((await fakeBrowser.tabs.get(page)).active).toBe(true);
        const { "vault.unlockTab": held } =
            await fakeBrowser.storage.session.get("vault.unlockTab");
        expect(held ?? null).toBeNull();
    });

    it("leaves the tab open when the password was wrong", async () => {
        await lockedByItself(null);
        const { popup, url } = await popupTab();

        const reply = await askFromTab({ kind: "unlock", password: "nope" }, popup, url);

        expect(reply.ok).toBe(false);
        expect((await fakeBrowser.tabs.get(popup)).id).toBe(popup);
    });
});
