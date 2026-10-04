/**
 * Polaris hosts, through the real worker: an install from before the list keeps
 * its connection and finds its host listed, switching to another host and back
 * brings the first one's session back untouched, and a name is checked by the
 * worker as well as by the screen.
 *
 * Driven against WXT's fake browser with the network refused - what is under
 * test is what the worker keeps and where, not what a server answers.
 */

import { SERVER_NAME_MAX } from "../src/lib/servers";
import { fakeBrowser } from "wxt/testing/fake-browser";
import type { Reply, Request } from "../src/lib/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HOME = "https://home.example.com";
const WORK = "https://work.example.com";

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

async function status() {
    const reply = await ask({ kind: "status" });
    if (!reply.ok || !("status" in reply)) throw new Error("no status");
    return reply.status;
}

/** A browser connected to HOME the way an install from before the hosts list
 *  left it: an address, a connection and a vault session, and no list at all. */
async function oldInstall(): Promise<void> {
    await fakeBrowser.storage.local.set({
        "server.origin": HOME,
        "vault.email": "ada@example.com",
        "link.token": "home-connection",
        "link.account": { name: "Ada Lovelace", email: "ada@example.com" }
    });
    await fakeBrowser.storage.session.set({
        "vault.refresh": "home-refresh",
        "vault.accountKey": "home-account-key"
    });
}

/** Every token refresh the worker sent: where, and with which refresh token. */
let refreshes: { url: string; token: string | null }[] = [];

/**
 * The network: a token refresh is answered, with the refresh token rotated as a
 * real server rotates it, and everything else is refused. Answering it is what
 * lets a switch back keep its session - a refused refresh ends one, by design.
 */
async function network(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/vault/identity/connect/token")) {
        const token = new URLSearchParams(String(init?.body ?? "")).get("refresh_token");
        refreshes.push({ url, token });
        return new Response(
            JSON.stringify({
                access_token: "access",
                refresh_token: `${token}-rotated`,
                Key: "wrapped-key"
            }),
            { headers: { "content-type": "application/json" } }
        );
    }
    throw new Error("offline");
}

beforeEach(async () => {
    fakeBrowser.reset();
    vi.resetModules();
    refreshes = [];
    vi.stubGlobal("fetch", network);
    // Every address is granted, as Chromium grants them; the fake has no
    // permissions API of its own.
    (fakeBrowser as unknown as { permissions: unknown }).permissions = {
        contains: async () => true,
        request: async () => true,
        getAll: async () => ({ origins: [], permissions: [] }),
        onAdded: { addListener() {} },
        onRemoved: { addListener() {} }
    };
    // The badge's right-click entries are redrawn on a switch; the fake has none.
    (fakeBrowser as unknown as { contextMenus: unknown }).contextMenus = {
        create() {},
        update: async () => {},
        removeAll: async () => {},
        onClicked: { addListener() {} }
    };
    // And the page script is re-registered for the host now in front.
    (fakeBrowser as unknown as { scripting: unknown }).scripting = {
        registerContentScripts: async () => {},
        unregisterContentScripts: async () => {}
    };
    await import("../src/entrypoints/background");
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("an install from before the hosts list", () => {
    it("is written onto the list on startup, with its connection left where it was", async () => {
        await oldInstall();
        const { settleSavedServers } = await import("../src/lib/server");
        await settleSavedServers();

        const stored = await fakeBrowser.storage.local.get(["servers.list", "link.token"]);
        expect(stored["servers.list"]).toEqual([{ origin: HOME, name: null }]);
        expect(stored["link.token"]).toBe("home-connection");
        const session = await fakeBrowser.storage.session.get("vault.refresh");
        expect(session["vault.refresh"]).toBe("home-refresh");

        const now = await status();
        expect(now.server).toBe(HOME);
        expect(now.linked).toBe(true);
        expect(now.servers).toEqual([
            { origin: HOME, name: null, host: "home.example.com", active: true, accounts: 1 }
        ]);
    });

    it("writes nothing the second time, and keeps a name already given", async () => {
        await oldInstall();
        await fakeBrowser.storage.local.set({ "servers.list": [{ origin: HOME, name: "Home" }] });
        const { settleSavedServers } = await import("../src/lib/server");
        const writes = vi.spyOn(fakeBrowser.storage.local, "set");
        await settleSavedServers();
        await settleSavedServers();
        expect(writes).not.toHaveBeenCalled();
        expect((await status()).servers[0]?.name).toBe("Home");
    });

    it("drops a malformed stored row without losing the good ones", async () => {
        await oldInstall();
        await fakeBrowser.storage.local.set({
            "servers.list": [
                { origin: WORK, name: "x".repeat(SERVER_NAME_MAX + 5) },
                { origin: "not an address", name: "Broken" },
                { origin: WORK, name: "Twice" },
                null
            ]
        });
        const { settleSavedServers } = await import("../src/lib/server");
        await settleSavedServers();
        const stored = await fakeBrowser.storage.local.get("servers.list");
        expect(stored["servers.list"]).toEqual([
            { origin: WORK, name: null },
            { origin: HOME, name: null }
        ]);
    });
});

describe("switching hosts", () => {
    it("sets the one in front aside and brings it back with its own connection", async () => {
        await oldInstall();

        expect((await ask({ kind: "addServer", typed: "work.example.com" })).ok).toBe(true);
        const atWork = await status();
        expect(atWork.server).toBe(WORK);
        expect(atWork.linked).toBe(false);
        expect(atWork.servers.map((one) => [one.origin, one.active])).toEqual([
            [WORK, true],
            [HOME, false]
        ]);
        // HOME's connection is kept, set aside, not sent to WORK.
        expect(
            (await fakeBrowser.storage.local.get("link.token"))["link.token"] ?? null
        ).toBeNull();

        expect((await ask({ kind: "switchServer", origin: HOME })).ok).toBe(true);
        const back = await status();
        expect(back.server).toBe(HOME);
        expect(back.linked).toBe(true);
        expect((await fakeBrowser.storage.local.get("link.token"))["link.token"]).toBe(
            "home-connection"
        );
        // HOME's own vault session came back: its refresh token was the one
        // sent, to HOME and to nowhere else.
        expect(refreshes).toEqual([
            { url: `${HOME}/vault/identity/connect/token`, token: "home-refresh" }
        ]);
        expect((await fakeBrowser.storage.session.get("vault.refresh"))["vault.refresh"]).toBe(
            "home-refresh-rotated"
        );
        // And WORK is still on the list to go back to.
        expect(back.servers.map((one) => one.origin).sort()).toEqual([HOME, WORK]);
    });

    it("refuses a host that is not on the list", async () => {
        await oldInstall();
        const reply = await ask({ kind: "switchServer", origin: "https://elsewhere.example.com" });
        expect(reply.ok).toBe(false);
        expect((await status()).server).toBe(HOME);
    });
});

describe("renaming a host", () => {
    it("stores the trimmed name, and the host again when emptied", async () => {
        await oldInstall();
        expect((await ask({ kind: "renameServer", origin: HOME, name: "  Home   lab " })).ok).toBe(
            true
        );
        expect((await status()).servers[0]?.name).toBe("Home lab");
        expect((await ask({ kind: "renameServer", origin: HOME, name: "   " })).ok).toBe(true);
        expect((await status()).servers[0]?.name).toBeNull();
    });

    it("refuses a name past the limit, and leaves the old one", async () => {
        await oldInstall();
        await ask({ kind: "renameServer", origin: HOME, name: "Home" });
        const reply = await ask({
            kind: "renameServer",
            origin: HOME,
            name: "x".repeat(SERVER_NAME_MAX + 1)
        });
        expect(reply.ok).toBe(false);
        if (!reply.ok) expect(reply.error).toContain(String(SERVER_NAME_MAX));
        expect((await status()).servers[0]?.name).toBe("Home");
    });
});
