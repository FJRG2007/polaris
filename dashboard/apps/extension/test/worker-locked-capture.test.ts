/**
 * A login submitted while the vault cannot take it, through the real worker.
 *
 * It used to pass in silence: a password changed on a site with the vault locked
 * was never offered for saving, and nothing said why. Now the page is told the
 * vault is locked (or not connected), the login waits, and once the vault opens
 * it is weighed and offered like any other.
 */

import { fakeBrowser } from "wxt/testing/fake-browser";
import { KDF_PBKDF2, type KdfSettings } from "@polaris/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Reply, Request } from "../src/lib/messages";
import { createVaultKeys, encrypt, type SymmetricKey } from "@polaris/vault-crypto";

const EMAIL = "someone@example.com";
const PASSWORD = "the master password";
const ORIGIN = "https://polaris.example";
const SITE = { tabId: 7, url: "https://accounts.shop.example.org/signin" };

/** Far below a real vault's cost: this is about the worker, not the derivation. */
const PBKDF2: KdfSettings = {
    kdf: KDF_PBKDF2,
    kdfIterations: 1000,
    kdfMemory: null,
    kdfParallelism: null
};

/** What the stub server holds right now. */
let ciphers: Record<string, unknown>[] = [];

function server(input: RequestInfo | URL): Promise<Response> {
    const address = String(input instanceof Request ? input.url : input);
    if (address === `${ORIGIN}/vault/api/accounts/revision-date`) {
        return Promise.resolve(new Response("1"));
    }
    if (address.startsWith(`${ORIGIN}/vault/api/sync`)) {
        return Promise.resolve(
            new Response(JSON.stringify({ profile: { email: EMAIL }, ciphers }), {
                headers: { "content-type": "application/json" }
            })
        );
    }
    return Promise.resolve(new Response("", { status: 503 }));
}

/** Ask the worker as the inline script on SITE does. */
async function ask(request: Request, from = SITE): Promise<Reply> {
    let answer: (reply: Reply) => void = () => {};
    const replied = new Promise<Reply>((resolve) => (answer = resolve));
    const sender = { id: fakeBrowser.runtime.id, tab: { id: from.tabId } as never, url: from.url };
    const held = await fakeBrowser.runtime.onMessage.trigger(request, sender, answer);
    expect(held).toContain(true);
    return replied;
}

/** A connected browser, signed in as Ada, with its vault locked. */
async function connected(): Promise<SymmetricKey> {
    const { keys, vaultKey } = await createVaultKeys(PASSWORD, EMAIL, PBKDF2);
    await fakeBrowser.storage.local.set({
        "server.origin": ORIGIN,
        "vault.email": EMAIL,
        "link.token": "connection-token"
    });
    await fakeBrowser.storage.session.set({
        "vault.refresh": "refresh-token",
        "vault.accountKey": "account-key",
        "vault.account": { name: "Ada Lovelace", email: EMAIL },
        "vault.access": { token: "access-token", expiresAt: Date.now() + 3_600_000 },
        "vault.wrapped": {
            key: keys.protectedKey,
            privateKey: keys.encryptedPrivateKey,
            kdf: PBKDF2
        }
    });
    return vaultKey;
}

/** Open the vault from the popup and let the sync it starts land. */
async function unlock(): Promise<void> {
    let answer: (reply: Reply) => void = () => {};
    const replied = new Promise<Reply>((resolve) => (answer = resolve));
    await fakeBrowser.runtime.onMessage.trigger(
        { kind: "unlock", password: PASSWORD },
        { id: fakeBrowser.runtime.id },
        answer
    );
    expect((await replied).ok).toBe(true);
    await vi.waitFor(async () => {
        const held = await fakeBrowser.storage.session.get("vault.ciphers");
        expect(held["vault.ciphers"]).toBeTruthy();
    });
}

/** A saved login for the site, as the server stores it. */
async function loginCipher(key: SymmetricKey, username: string, password: string) {
    return {
        id: "shop-login",
        type: 1,
        name: await encrypt("Shop", key),
        login: {
            username: await encrypt(username, key),
            password: await encrypt(password, key),
            uris: [{ uri: await encrypt("https://shop.example.org", key), match: null }]
        }
    };
}

function offerOf(reply: Reply) {
    return reply.ok && "offer" in reply ? reply.offer : null;
}

const SUBMITTED: Request = { kind: "captured", username: "ada", password: "new password 2" };

beforeEach(async () => {
    fakeBrowser.reset();
    vi.resetModules();
    ciphers = [];
    vi.stubGlobal("fetch", server);
    await import("../src/entrypoints/background");
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("a login submitted with the vault locked", () => {
    it("says the vault is locked instead of passing in silence", async () => {
        await connected();
        expect(offerOf(await ask(SUBMITTED))).toEqual({
            kind: "locked",
            name: "accounts.shop.example.org",
            username: "ada"
        });
        // Asked again after the page the sign-in landed on.
        expect(offerOf(await ask({ kind: "pendingCapture" }))?.kind).toBe("locked");
    });

    it("is offered as an update once the vault opens, for a changed password", async () => {
        const key = await connected();
        ciphers = [await loginCipher(key, "ada", "old password 1")];
        await ask(SUBMITTED);
        await unlock();
        const offer = offerOf(await ask({ kind: "pendingCapture" }));
        expect(offer).toEqual({ kind: "update", name: "Shop", username: "ada" });
    });

    it("is offered as a save once the vault opens, when nothing is saved for the site", async () => {
        await connected();
        await ask(SUBMITTED);
        await unlock();
        expect(offerOf(await ask({ kind: "pendingCapture" }))?.kind).toBe("save");
    });

    it("is not offered on another tab, and goes with Not now", async () => {
        await connected();
        await ask(SUBMITTED);
        const elsewhere = { tabId: 8, url: SITE.url };
        expect(offerOf(await ask({ kind: "pendingCapture" }, elsewhere))?.kind).toBe("none");
        await ask({ kind: "dismissCapture", never: false });
        await unlock();
        expect(offerOf(await ask({ kind: "pendingCapture" }))?.kind).toBe("none");
    });

    it("says the browser is not connected when there is no connection", async () => {
        expect(offerOf(await ask(SUBMITTED))?.kind).toBe("unlinked");
    });

    it("stays quiet on a site the extension is switched off for", async () => {
        await connected();
        await fakeBrowser.storage.local.set({ "blocked.hosts": ["shop.example.org"] });
        expect(offerOf(await ask(SUBMITTED))?.kind).toBe("none");
    });
});
