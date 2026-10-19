// @vitest-environment jsdom
/**
 * A login that keeps its email apart from its username, filled into real markup:
 * the worker's own page script runs here against the document, so what is under
 * test is the box each value lands in, not the arguments it was handed.
 */

import { fakeBrowser } from "wxt/testing/fake-browser";
import type { Reply, Request } from "../src/lib/messages";
import { EMAIL_FIELD, KDF_PBKDF2, type KdfSettings } from "@polaris/core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createVaultKeys, encrypt, type SymmetricKey } from "@polaris/vault-crypto";

const EMAIL = "someone@example.com";
const PASSWORD = "the master password";
const ORIGIN = "https://polaris.example";
const SITE = "https://shop.example.org";
const TAB = 7;

const PBKDF2: KdfSettings = {
    kdf: KDF_PBKDF2,
    kdfIterations: 1000,
    kdfMemory: null,
    kdfParallelism: null
};

let ciphers: Record<string, unknown>[] = [];

function json(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" }
    });
}

function server(input: RequestInfo | URL): Promise<Response> {
    const address = String(input instanceof Request ? input.url : input);
    if (address === `${ORIGIN}/vault/api/accounts/revision-date`) {
        return Promise.resolve(new Response("2"));
    }
    if (address.startsWith(`${ORIGIN}/vault/api/sync`)) {
        return Promise.resolve(json({ profile: { email: EMAIL }, ciphers }));
    }
    return Promise.resolve(new Response("", { status: 503 }));
}

async function ask(request: Request, from?: { tabId: number; url: string }): Promise<Reply> {
    let answer: (reply: Reply) => void = () => {};
    const replied = new Promise<Reply>((resolve) => (answer = resolve));
    const sender = from
        ? { id: fakeBrowser.runtime.id, tab: { id: from.tabId } as never, url: from.url }
        : { id: fakeBrowser.runtime.id };
    await fakeBrowser.runtime.onMessage.trigger(request, sender, answer);
    return replied;
}

async function login(
    key: SymmetricKey,
    fields: { username: string | null; email: string | null }
): Promise<Record<string, unknown>> {
    return {
        id: "item-1",
        type: 1,
        name: await encrypt("Shop", key),
        login: {
            username: fields.username === null ? null : await encrypt(fields.username, key),
            password: await encrypt("hunter2", key),
            uris: [{ uri: await encrypt(SITE, key), match: null }]
        },
        fields:
            fields.email === null
                ? null
                : [
                      {
                          name: await encrypt(EMAIL_FIELD, key),
                          value: await encrypt(fields.email, key),
                          type: 0
                      }
                  ]
    };
}

async function unlockedVault(): Promise<SymmetricKey> {
    const { keys, vaultKey } = await createVaultKeys(PASSWORD, EMAIL, PBKDF2);
    await fakeBrowser.storage.local.set({
        "server.origin": ORIGIN,
        "vault.email": EMAIL,
        "link.token": "connection-token"
    });
    await fakeBrowser.storage.session.set({
        "vault.refresh": "refresh-token",
        "vault.accountKey": "account-key",
        "vault.access": { token: "access-token", expiresAt: Date.now() + 3_600_000 },
        "vault.wrapped": {
            key: keys.protectedKey,
            privateKey: keys.encryptedPrivateKey,
            kdf: PBKDF2
        }
    });
    const opened = await ask({ kind: "unlock", password: PASSWORD });
    expect(opened.ok).toBe(true);
    return vaultKey;
}

/** Fill the one login into `markup` and return the boxes, by id. */
async function fill(
    markup: string,
    fields: { username: string | null; email: string | null }
): Promise<Record<string, string>> {
    const key = await unlockedVault();
    ciphers = [await login(key, fields)];
    await ask({ kind: "sync" });
    document.body.innerHTML = markup;
    const filled = await ask({ kind: "fill", id: "item-1" }, { tabId: TAB, url: `${SITE}/login` });
    expect(filled.ok).toBe(true);
    return Object.fromEntries(
        [...document.querySelectorAll("input")].map((box) => [box.id, box.value])
    );
}

const EMAIL_BOX = `<form>
    <input id="user" type="email" name="email">
    <input id="pass" type="password" name="password">
</form>`;

const NAME_BOX = `<form>
    <input id="user" type="text" name="username" autocomplete="username">
    <input id="pass" type="password" name="password">
</form>`;

beforeAll(() => {
    HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
        return {
            x: 10,
            y: 10,
            top: 10,
            left: 10,
            width: 200,
            height: 30,
            right: 210,
            bottom: 40,
            toJSON: () => ({})
        } as DOMRect;
    };
});

beforeEach(async () => {
    fakeBrowser.reset();
    vi.resetModules();
    ciphers = [];
    vi.stubGlobal("fetch", server);
    const scripting = fakeBrowser.scripting as unknown as Record<string, unknown>;
    scripting.executeScript = vi.fn(
        async (injection: { func: (...args: unknown[]) => unknown; args?: unknown[] }) => [
            { result: injection.func(...(injection.args ?? [])) }
        ]
    );
    await import("../src/entrypoints/background");
});

afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
});

describe("a login with an email apart from its username", () => {
    it("types the email into a box that asks for one", async () => {
        const boxes = await fill(EMAIL_BOX, { username: "someone", email: "me@shop.example" });
        expect(boxes).toEqual({ user: "me@shop.example", pass: "hunter2" });
    });

    it("types the username into a box that asks for a name", async () => {
        const boxes = await fill(NAME_BOX, { username: "someone", email: "me@shop.example" });
        expect(boxes).toEqual({ user: "someone", pass: "hunter2" });
    });

    it("falls back to the email when there is no username", async () => {
        const boxes = await fill(NAME_BOX, { username: null, email: "me@shop.example" });
        expect(boxes).toEqual({ user: "me@shop.example", pass: "hunter2" });
    });

    it("falls back to the username when an email box finds no email", async () => {
        const boxes = await fill(EMAIL_BOX, { username: "someone", email: null });
        expect(boxes).toEqual({ user: "someone", pass: "hunter2" });
    });
});

describe("the popup's copy of a login with only an email", () => {
    it("shows the email and copies it", async () => {
        const key = await unlockedVault();
        ciphers = [await login(key, { username: null, email: "me@shop.example" })];
        await ask({ kind: "sync" });

        const listed = await ask({ kind: "items", query: "" });
        const copied = await ask({ kind: "copy", id: "item-1", field: "username" });

        expect(listed.ok && "items" in listed ? listed.items[0]?.username : undefined).toBe(
            "me@shop.example"
        );
        expect(copied).toEqual({ ok: true, value: "me@shop.example" });
    });
});
