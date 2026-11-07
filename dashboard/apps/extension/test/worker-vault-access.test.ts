/**
 * An account without vault access, through the real worker.
 *
 * The connection says `can.vault`, and Polar's entries have long honoured
 * `can.polar`. The vault's did not: a browser holding a vault session kept the
 * vault row, the page marks and the save offers for an account Polaris had
 * already said may not use one. These pin each of those, and that a popup
 * opening is enough to find out the access was taken away.
 */

import { fakeBrowser } from "wxt/testing/fake-browser";
import type { Reply, Request, VaultStatus } from "../src/lib/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGIN = "https://polaris.example";
const SITE = { tabId: 7, url: "https://shop.example.org/login" };

/** What the session endpoint says the account may use right now. */
let can = { vault: true, polar: true };
let sessionAsks = 0;

async function network(input: RequestInfo | URL): Promise<Response> {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${ORIGIN}/api/extension/session`) {
        sessionAsks++;
        return Response.json({
            connection: { id: "c1", name: "Chrome" },
            account: { id: "u1", name: "Arnau", email: "arnau@example.com" },
            organizations: [],
            can
        });
    }
    return new Response("", { status: 503 });
}

async function ask(request: Request, from: typeof SITE | null = null): Promise<Reply> {
    let answer: (reply: Reply) => void = () => {};
    const replied = new Promise<Reply>((resolve) => (answer = resolve));
    const sender = from
        ? { id: fakeBrowser.runtime.id, tab: { id: from.tabId } as never, url: from.url }
        : { id: fakeBrowser.runtime.id };
    await fakeBrowser.runtime.onMessage.trigger(request, sender, answer);
    return replied;
}

async function statusOf(kind: "status" | "statusChecked"): Promise<VaultStatus> {
    const reply = await ask({ kind });
    if (!reply.ok || !("status" in reply)) throw new Error("no status");
    return reply.status;
}

const created: string[] = [];

beforeEach(async () => {
    fakeBrowser.reset();
    vi.resetModules();
    can = { vault: true, polar: true };
    sessionAsks = 0;
    created.length = 0;
    vi.stubGlobal("fetch", network);
    (fakeBrowser as unknown as { contextMenus: unknown }).contextMenus = {
        create(entry: { id: string }) {
            created.push(entry.id);
        },
        update: async () => {},
        removeAll: async () => {
            created.length = 0;
        },
        onClicked: { addListener() {} }
    };
    await fakeBrowser.storage.local.set({
        "server.origin": ORIGIN,
        "link.token": "connection"
    });
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("an account the vault is kept from", () => {
    it("answers every page as switched off, so nothing is marked or offered", async () => {
        await fakeBrowser.storage.local.set({ "link.vault": false });
        await import("../src/entrypoints/background");

        expect(await ask({ kind: "blocked" }, SITE)).toEqual({
            ok: true,
            host: "shop.example.org",
            blocked: true
        });
        expect((await ask({ kind: "itemsFor", url: SITE.url }, SITE)).ok).toBe(false);
        expect((await ask({ kind: "pendingCapture" }, SITE)).ok).toBe(false);
    });

    it("says so in the popup's status", async () => {
        await fakeBrowser.storage.local.set({ "link.vault": false });
        await import("../src/entrypoints/background");
        expect((await statusOf("status")).canVault).toBe(false);
    });

    it("finds out on the popup opening, past the once-a-minute floor", async () => {
        await import("../src/entrypoints/background");
        expect((await statusOf("statusChecked")).canVault).toBe(true);
        const asked = sessionAsks;

        // Taken away on Polaris a moment later: the routine ask is still inside
        // its floor, and the popup's own check is not.
        can = { vault: false, polar: true };
        expect((await statusOf("status")).canVault).toBe(true);
        expect((await statusOf("statusChecked")).canVault).toBe(false);
        expect(sessionAsks).toBeGreaterThan(asked);
    });

    it("drops the vault's right-click entries and its page script, and keeps Polar's", async () => {
        const registered: string[] = [];
        const stub = fakeBrowser as unknown as Record<string, unknown>;
        stub.permissions = {
            contains: async () => true,
            request: async () => true,
            getAll: async () => ({ origins: ["https://*/*"], permissions: [] }),
            onAdded: { addListener() {} },
            onRemoved: { addListener() {} }
        };
        stub.scripting = {
            registerContentScripts: async (scripts: { id: string }[]) => {
                registered.push(...scripts.map((one) => one.id));
            },
            unregisterContentScripts: async () => {
                registered.length = 0;
            }
        };
        stub.management = { getSelf: async () => ({ installType: "normal" }) };
        stub.sidePanel = { setOptions: async () => undefined };
        stub.commands = { onCommand: { addListener() {} } };
        (fakeBrowser.runtime as unknown as { onConnect: unknown }).onConnect = {
            addListener() {}
        };
        await fakeBrowser.storage.local.set({ "inline.everywhere": true });
        const background = await import("../src/entrypoints/background");
        background.default.main?.();
        await vi.waitFor(() => expect(created).toContain("polaris-fill"));
        await vi.waitFor(() => expect(registered).toContain("polaris-autofill"));

        // Taken away, and found out on the popup opening.
        can = { vault: false, polar: true };
        await statusOf("statusChecked");
        await vi.waitFor(() => expect(created).not.toContain("polaris-fill"));
        expect(created).not.toContain("polaris-generate");
        expect(created).toContain("polaris-polar-page");
        await vi.waitFor(() => expect(registered).toEqual([]));
    });
});
