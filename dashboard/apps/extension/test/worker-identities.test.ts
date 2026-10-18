/**
 * Identities for a sign-up, through the real worker: refused with the vault
 * locked or the site switched off, only the open shelf's own offered and opened,
 * and the account's own identity only while that shelf holds none.
 *
 * Driven against WXT's fake browser with the server answered by a stub - what is
 * under test is what the worker hands a page, not the network.
 */

import { fakeBrowser } from "wxt/testing/fake-browser";
import { KDF_PBKDF2, type KdfSettings } from "@polaris/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_IDENTITY, type Reply, type Request } from "../src/lib/messages";
import { createVaultKeys, encrypt, type SymmetricKey } from "@polaris/vault-crypto";

const EMAIL = "someone@example.com";
const PASSWORD = "the master password";
const ORIGIN = "https://polaris.example";
const SITE = { tabId: 7, url: "https://shop.example.org/register" };

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

/** An identity as the server stores it: every leaf encrypted with the vault key. */
async function identityCipher(
    key: SymmetricKey,
    id: string,
    fields: { name: string; firstName: string; email: string; isDefault?: boolean }
): Promise<Record<string, unknown>> {
    return {
        id,
        type: 4,
        name: await encrypt(fields.name, key),
        defaultIdentity: fields.isDefault === true,
        identity: {
            firstName: await encrypt(fields.firstName, key),
            email: await encrypt(fields.email, key)
        }
    };
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

function cardIds(reply: Reply): string[] {
    return reply.ok && "identities" in reply ? reply.identities.map((one) => one.id) : [];
}

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

describe("identities for a sign-up", () => {
    it("are refused while the vault is locked", async () => {
        const key = await connected();
        ciphers = [
            await identityCipher(key, "home", { name: "Home", firstName: "Ada", email: EMAIL })
        ];

        expect(await ask({ kind: "identities" })).toEqual({
            ok: false,
            error: "Unlock Polaris first."
        });
        expect((await ask({ kind: "identity", id: "home" })).ok).toBe(false);
        expect((await ask({ kind: "identity", id: ACCOUNT_IDENTITY })).ok).toBe(false);
    });

    it("are refused on a site the extension is switched off for", async () => {
        const key = await connected();
        ciphers = [
            await identityCipher(key, "home", { name: "Home", firstName: "Ada", email: EMAIL })
        ];
        await unlock();
        await fakeBrowser.storage.local.set({ "blocked.hosts": ["example.org"] });

        const off = { ok: false, error: "This extension is switched off for this site." };
        expect(await ask({ kind: "identities" })).toEqual(off);
        expect(await ask({ kind: "identity", id: "home" })).toEqual(off);
        expect(await ask({ kind: "identity", id: ACCOUNT_IDENTITY })).toEqual(off);
    });

    it("offer the shelf's own, default first, and never the account's beside them", async () => {
        const key = await connected();
        ciphers = [
            await identityCipher(key, "work", {
                name: "Work",
                firstName: "Ada",
                email: "w@example.com"
            }),
            await identityCipher(key, "home", {
                name: "Home",
                firstName: "Ada",
                email: EMAIL,
                isDefault: true
            })
        ];
        await unlock();

        expect(cardIds(await ask({ kind: "identities" }))).toEqual(["home", "work"]);
        const opened = await ask({ kind: "identity", id: "work" });
        expect(opened.ok && "identity" in opened ? opened.identity.email : null).toBe(
            "w@example.com"
        );
        expect(await ask({ kind: "identity", id: ACCOUNT_IDENTITY })).toEqual({
            ok: false,
            error: "That identity is no longer in this vault."
        });
    });

    it("open nothing from another shelf, or that is not an identity", async () => {
        const key = await connected();
        ciphers = [
            await identityCipher(key, "home", { name: "Home", firstName: "Ada", email: EMAIL }),
            { id: "a-login", type: 1, name: await encrypt("Shop", key), login: {} }
        ];
        await unlock();
        await fakeBrowser.storage.local.set({
            "link.orgs": [{ id: "org-1", name: "Team", vaultId: "vault-1" }],
            "link.shelf": "org-1"
        });

        const gone = { ok: false, error: "That identity is no longer in this vault." };
        expect(await ask({ kind: "identity", id: "home" })).toEqual(gone);
        expect(await ask({ kind: "identity", id: "a-login" })).toEqual(gone);
        expect(await ask({ kind: "identity", id: "nowhere" })).toEqual(gone);
        expect(cardIds(await ask({ kind: "identities" }))).toEqual([ACCOUNT_IDENTITY]);
    });

    it("fall back to the account's own when the shelf holds none", async () => {
        await connected();
        await unlock();

        expect(cardIds(await ask({ kind: "identities" }))).toEqual([ACCOUNT_IDENTITY]);
        const opened = await ask({ kind: "identity", id: ACCOUNT_IDENTITY });
        expect(opened.ok && "identity" in opened ? opened.identity : null).toMatchObject({
            firstName: "Ada",
            lastName: "Lovelace",
            email: EMAIL
        });
    });
});
