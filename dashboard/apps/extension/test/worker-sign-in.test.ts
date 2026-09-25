/**
 * The extension getting out of the way: logins that arrive without a Sync button,
 * a login picked once for a sign-in split over several pages, and the tab an
 * approval opened closing once it has been answered.
 *
 * Each of these drives the real message listener against WXT's fake browser, with
 * the server answered by a stub - what is under test is what the worker does with
 * the answers, not the network.
 */

import { fakeBrowser } from "wxt/testing/fake-browser";
import type { Reply, Request } from "../src/lib/messages";
import { KDF_PBKDF2, type KdfSettings } from "@polaris/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVaultKeys, encrypt, type SymmetricKey } from "@polaris/vault-crypto";

const EMAIL = "someone@example.com";
const PASSWORD = "the master password";
const ORIGIN = "https://polaris.example";
const SITE = "https://shop.example.org";

/** Far below a real vault's cost: this is about the worker, not the derivation. */
const PBKDF2: KdfSettings = {
    kdf: KDF_PBKDF2,
    kdfIterations: 1000,
    kdfMemory: null,
    kdfParallelism: null
};

/** What the stub server holds right now. */
let revision = 1;
let ciphers: Record<string, unknown>[] = [];
/** Every address the worker asked, in order. */
let asked: string[] = [];
/** How the stubbed server answers the extension's own connection routes. */
let linkAnswers: {
    claim: Record<string, unknown>;
    session: Record<string, unknown> | null;
} = { claim: { status: "pending" }, session: null };

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" }
    });
}

function server(input: RequestInfo | URL): Promise<Response> {
    const address = String(input instanceof Request ? input.url : input);
    asked.push(address);
    if (address === `${ORIGIN}/vault/api/accounts/revision-date`) {
        return Promise.resolve(new Response(String(revision)));
    }
    if (address.startsWith(`${ORIGIN}/vault/api/sync`)) {
        return Promise.resolve(json({ profile: { email: EMAIL }, ciphers }));
    }
    if (address === `${ORIGIN}/vault/identity/connect/authorize`) {
        return Promise.resolve(
            json({ userCode: "VAULT-CODE", deviceCode: "vault-device", pollMs: 1000 })
        );
    }
    if (address === `${ORIGIN}/api/extension/authorize`) {
        return Promise.resolve(
            json({
                userCode: "LINK-CODE",
                deviceCode: "link-device",
                pollMs: 1000,
                approveUrl: "/account/extension?code=LINK-CODE"
            })
        );
    }
    if (address === `${ORIGIN}/api/extension/authorize/claim`) {
        return Promise.resolve(json(linkAnswers.claim));
    }
    if (address === `${ORIGIN}/api/extension/session` && linkAnswers.session) {
        return Promise.resolve(json(linkAnswers.session));
    }
    return Promise.resolve(new Response("", { status: 503 }));
}

/** Ask the worker as the popup does (no tab), or as a page does (`from`). */
async function ask(request: Request, from?: { tabId: number; url: string }): Promise<Reply> {
    let answer: (reply: Reply) => void = () => {};
    const replied = new Promise<Reply>((resolve) => (answer = resolve));
    // The worker reads the tab's id and nothing else of it.
    const sender = from
        ? { id: fakeBrowser.runtime.id, tab: { id: from.tabId } as never, url: from.url }
        : { id: fakeBrowser.runtime.id };
    const held = await fakeBrowser.runtime.onMessage.trigger(request, sender, answer);
    expect(held).toContain(true);
    return replied;
}

/** A login as the server stores it: every leaf encrypted with the vault key. */
async function login(
    key: SymmetricKey,
    id: string,
    fields: { name: string; username: string; password: string; uri: string }
): Promise<Record<string, unknown>> {
    return {
        id,
        type: 1,
        name: await encrypt(fields.name, key),
        login: {
            username: await encrypt(fields.username, key),
            password: await encrypt(fields.password, key),
            uris: [{ uri: await encrypt(fields.uri, key), match: null }]
        }
    };
}

/** A connected browser whose vault is open, holding `ciphers` as of `revision`. */
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

function names(reply: Reply): string[] {
    return reply.ok && "items" in reply ? reply.items.map((item) => item.name) : [];
}

/** Let the worker's own background work - a sync after unlocking - land. */
async function settle(): Promise<void> {
    for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

let clock = Date.now();

beforeEach(async () => {
    fakeBrowser.reset();
    vi.resetModules();
    revision = 1;
    ciphers = [];
    asked = [];
    linkAnswers = { claim: { status: "pending" }, session: null };
    clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    vi.stubGlobal("fetch", server);
    await import("../src/entrypoints/background");
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("a login saved in Polaris", () => {
    it("is in the next list, without anybody pressing Sync", async () => {
        const key = await unlockedVault();
        await settle();
        expect(names(await ask({ kind: "items", query: "" }))).toEqual([]);

        // Saved in the dashboard: the server's revision moves with it.
        ciphers = [
            await login(key, "item-1", {
                name: "Shop",
                username: "someone",
                password: "hunter2",
                uri: SITE
            })
        ];
        revision = 2;
        clock += 11_000;

        expect(names(await ask({ kind: "itemsFor", url: `${SITE}/login` }))).toEqual(["Shop"]);
    });

    it("asks the server once for a burst of lists, not once per list", async () => {
        await unlockedVault();
        await settle();
        clock += 11_000;
        asked = [];

        await ask({ kind: "items", query: "" });
        await ask({ kind: "items", query: "s" });
        await ask({ kind: "items", query: "sh" });

        const looks = asked.filter((address) => address.endsWith("/revision-date"));
        expect(looks).toHaveLength(1);
        // Nothing moved, so nothing but the revision was fetched.
        expect(asked.some((address) => address.includes("/api/sync"))).toBe(false);
    });

    it("is not asked about while the vault is locked", async () => {
        await unlockedVault();
        await settle();
        await ask({ kind: "lock" });
        clock += 11_000;
        asked = [];

        await ask({ kind: "items", query: "" });

        expect(asked.filter((address) => address.includes("/vault/api/"))).toEqual([]);
    });
});

describe("a sign-in that asks for the password on its next page", () => {
    const TAB = 41;
    let typed: unknown[][] = [];
    /** What the page reports finding, one answer per fill. */
    let found: { user: boolean; pass: boolean; code: boolean }[] = [];

    beforeEach(() => {
        typed = [];
        found = [];
        const scripting = fakeBrowser.scripting as unknown as Record<string, unknown>;
        scripting.executeScript = vi.fn(async (injection: { args?: unknown[] }) => {
            typed.push(injection.args ?? []);
            return [{ result: found.shift() ?? { user: false, pass: false, code: false } }];
        });
    });

    async function pickedOnFirstPage(): Promise<void> {
        const key = await unlockedVault();
        ciphers = [
            await login(key, "item-1", {
                name: "Shop",
                username: "someone",
                password: "hunter2",
                uri: SITE
            })
        ];
        revision = 2;
        await ask({ kind: "sync" });
        // The first page has the name and nothing else.
        found.push({ user: true, pass: false, code: false });
        const filled = await ask(
            { kind: "fill", id: "item-1" },
            { tabId: TAB, url: `${SITE}/login` }
        );
        expect(filled.ok).toBe(true);
    }

    it("fills the password there with the login picked on the first page", async () => {
        await pickedOnFirstPage();
        found.push({ user: false, pass: true, code: false });

        const next = await ask({ kind: "continueSignIn" }, { tabId: TAB, url: `${SITE}/password` });

        expect(next.ok).toBe(true);
        expect(typed.at(-1)).toEqual(["someone", "hunter2", null]);
    });

    it("fills it once, not on every password box that turns up after", async () => {
        await pickedOnFirstPage();
        found.push({ user: false, pass: true, code: false });
        await ask({ kind: "continueSignIn" }, { tabId: TAB, url: `${SITE}/password` });

        const again = await ask(
            { kind: "continueSignIn" },
            { tabId: TAB, url: `${SITE}/password` }
        );

        expect(again.ok).toBe(false);
    });

    it("hands nothing to another tab, or to the same tab on another site", async () => {
        await pickedOnFirstPage();
        const calls = typed.length;

        const otherTab = await ask(
            { kind: "continueSignIn" },
            { tabId: TAB + 1, url: `${SITE}/password` }
        );
        const otherSite = await ask(
            { kind: "continueSignIn" },
            { tabId: TAB, url: "https://evil.example.net/password" }
        );

        expect(otherTab.ok).toBe(false);
        expect(otherSite.ok).toBe(false);
        expect(typed).toHaveLength(calls);
    });

    it("waits for the name's fill when the password box shows up while it is typing", async () => {
        const key = await unlockedVault();
        ciphers = [
            await login(key, "item-1", {
                name: "Shop",
                username: "someone",
                password: "hunter2",
                uri: SITE
            })
        ];
        revision = 2;
        await ask({ kind: "sync" });
        found.push(
            { user: true, pass: false, code: false },
            { user: false, pass: true, code: false }
        );
        let asking: Promise<Reply> | null = null;
        const scripting = fakeBrowser.scripting as unknown as Record<string, unknown>;
        const typing = scripting.executeScript as (injection: {
            args?: unknown[];
        }) => Promise<unknown>;
        scripting.executeScript = vi.fn(async (injection: { args?: unknown[] }) => {
            // The page reveals the password box the moment the name is typed.
            asking ??= ask({ kind: "continueSignIn" }, { tabId: TAB, url: `${SITE}/login` });
            return typing(injection);
        });

        await ask({ kind: "fill", id: "item-1" }, { tabId: TAB, url: `${SITE}/login` });
        const next = await asking!;

        expect(next.ok).toBe(true);
        expect(typed.at(-1)).toEqual(["someone", "hunter2", null]);
    });

    it("keeps another tab's waiting step through a fill here", async () => {
        await pickedOnFirstPage();
        found.push({ user: true, pass: true, code: false });
        await ask({ kind: "fill", id: "item-1" }, { tabId: TAB + 1, url: `${SITE}/login` });
        found.push({ user: false, pass: true, code: false });

        const next = await ask({ kind: "continueSignIn" }, { tabId: TAB, url: `${SITE}/password` });

        expect(next.ok).toBe(true);
    });

    it("has nothing to finish after a fill that already typed the password", async () => {
        const key = await unlockedVault();
        ciphers = [
            await login(key, "item-1", {
                name: "Shop",
                username: "someone",
                password: "hunter2",
                uri: SITE
            })
        ];
        revision = 2;
        await ask({ kind: "sync" });
        found.push({ user: true, pass: true, code: false });
        await ask({ kind: "fill", id: "item-1" }, { tabId: TAB, url: `${SITE}/login` });

        const next = await ask({ kind: "continueSignIn" }, { tabId: TAB, url: `${SITE}/login` });

        expect(next.ok).toBe(false);
    });
});

describe("the tab an approval opens", () => {
    const ACCOUNT = { id: "account-1", email: EMAIL, name: "Someone" };

    beforeEach(() => {
        // The fake has one window and no idea which is current; asked with
        // `currentWindow` it throws. There is only one, so it is that one.
        const query = fakeBrowser.tabs.query.bind(fakeBrowser.tabs);
        vi.spyOn(fakeBrowser.tabs, "query").mockImplementation((info) => {
            const { currentWindow: _, ...rest } = info as Record<string, unknown>;
            return query(rest);
        });
    });

    /** The tabs showing this Polaris. */
    async function onPolaris(): Promise<{ id?: number; url?: string }[]> {
        const all = await fakeBrowser.tabs.query({});
        return all.filter((tab) => tab.url?.startsWith(`${ORIGIN}/`));
    }

    async function signingInFrom(): Promise<number> {
        await fakeBrowser.storage.local.set({ "server.origin": ORIGIN });
        const site = await fakeBrowser.tabs.create({ url: `${SITE}/login`, active: true });
        return site.id!;
    }

    /** Wait for the worker's poll, which is a second at its shortest. */
    async function answered(): Promise<void> {
        vi.mocked(Date.now).mockRestore();
        await new Promise((resolve) => setTimeout(resolve, 1_400));
        await settle();
    }

    it("closes once the connection is approved, and puts somebody back where they were", async () => {
        const site = await signingInFrom();
        linkAnswers.session = { account: ACCOUNT, can: { vault: false } };

        const opened = await ask({ kind: "link" });
        expect(opened.ok).toBe(true);
        const [approval] = await onPolaris();
        expect(approval?.url).toBe(`${ORIGIN}/account/extension?code=LINK-CODE`);

        linkAnswers.claim = { status: "approved", token: "connection-token", account: ACCOUNT };
        await answered();

        expect(await onPolaris()).toEqual([]);
        const [front] = await fakeBrowser.tabs.query({ active: true });
        expect(front?.id).toBe(site);
    });

    it("goes straight on to the vault in the same tab, where the account has one", async () => {
        await signingInFrom();
        linkAnswers.session = { account: ACCOUNT, can: { vault: true } };

        await ask({ kind: "link" });
        const [approval] = await onPolaris();
        linkAnswers.claim = { status: "approved", token: "connection-token", account: ACCOUNT };
        await answered();

        const still = await fakeBrowser.tabs.get(approval!.id!);
        expect(still.url).toBe(`${ORIGIN}/vault/authorize?code=VAULT-CODE`);
        expect(await onPolaris()).toHaveLength(1);
    }, 10_000);

    it("closes when it was turned down there too", async () => {
        await signingInFrom();

        await ask({ kind: "link" });
        const [approval] = await onPolaris();
        linkAnswers.claim = { status: "denied" };
        await answered();

        expect(await onPolaris()).toEqual([]);
    });

    it("leaves alone a tab somebody has taken somewhere else since", async () => {
        await signingInFrom();
        linkAnswers.session = { account: ACCOUNT, can: { vault: false } };

        await ask({ kind: "link" });
        const [approval] = await onPolaris();
        await fakeBrowser.tabs.update(approval!.id!, { url: "https://news.example.com/" });
        linkAnswers.claim = { status: "approved", token: "connection-token", account: ACCOUNT };
        await answered();

        expect((await fakeBrowser.tabs.get(approval!.id!)).url).toBe("https://news.example.com/");
    });
});

describe("the Unlock Polaris row on a locked page", () => {
    it("opens the popup in a tab when the browser will not open it from a page", async () => {
        const action = (fakeBrowser as unknown as { action: Record<string, unknown> }).action;
        action.openPopup = vi.fn(() => Promise.reject(new Error("needs a user gesture")));

        const reply = await ask({ kind: "openUnlock" }, { tabId: 7, url: `${SITE}/login` });

        expect(reply.ok).toBe(true);
        const tabs = await fakeBrowser.tabs.query({});
        expect(tabs.map((tab) => tab.url)).toContain(fakeBrowser.runtime.getURL("/popup.html"));
    });
});

/**
 * The popup opened in a tab has to work as the popup: that is where the row above
 * sends somebody when the toolbar will not open. The worker tells its own pages
 * from web pages by origin, and a web page asking the same is still refused.
 */
describe("the popup opened in a tab", () => {
    it("is answered like the popup", async () => {
        const reply = await ask(
            { kind: "status" },
            { tabId: 9, url: fakeBrowser.runtime.getURL("/popup.html") }
        );

        expect(reply.ok && "status" in reply).toBe(true);
    });

    it("does not let a web page ask what only the popup may", async () => {
        let answered = false;
        const held = await fakeBrowser.runtime.onMessage.trigger(
            { kind: "status" },
            { id: fakeBrowser.runtime.id, tab: { id: 9 } as never, url: `${SITE}/login` },
            () => (answered = true)
        );

        expect(held).not.toContain(true);
        expect(answered).toBe(false);
    });
});
