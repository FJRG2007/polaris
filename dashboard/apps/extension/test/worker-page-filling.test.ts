/**
 * Settings' "Fill in from the vault" and its list of switched-off sites,
 * through the real worker: a page is answered as switched off while it is off,
 * and a site named from the settings list is let back in without touching the
 * others.
 */

import { fakeBrowser } from "wxt/testing/fake-browser";
import type { Reply, Request } from "../src/lib/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SITE = { tabId: 7, url: "https://shop.example.org/login" };

async function ask(request: Request, from: typeof SITE | null = SITE): Promise<Reply> {
    let answer: (reply: Reply) => void = () => {};
    const replied = new Promise<Reply>((resolve) => (answer = resolve));
    const sender = from
        ? { id: fakeBrowser.runtime.id, tab: { id: from.tabId } as never, url: from.url }
        : { id: fakeBrowser.runtime.id };
    const held = await fakeBrowser.runtime.onMessage.trigger(request, sender, answer);
    expect(held).toContain(true);
    return replied;
}

beforeEach(async () => {
    fakeBrowser.reset();
    vi.resetModules();
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("", { status: 503 })));
    await import("../src/entrypoints/background");
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("filling inside web pages", () => {
    it("answers a page as switched off while the setting is off", async () => {
        expect(await ask({ kind: "blocked" })).toEqual({
            ok: true,
            host: "shop.example.org",
            blocked: false
        });

        await fakeBrowser.storage.local.set({ "inline.enabled": false });
        expect(await ask({ kind: "blocked" })).toEqual({
            ok: true,
            host: "shop.example.org",
            blocked: true
        });
        expect((await ask({ kind: "itemsFor", url: SITE.url })).ok).toBe(false);
    });

    it("lets one named site back in and keeps the rest", async () => {
        await fakeBrowser.storage.local.set({
            "blocked.hosts": ["shop.example.org", "bank.example.com"]
        });

        expect(
            (await ask({ kind: "setBlocked", blocked: false, host: "shop.example.org" }, null)).ok
        ).toBe(true);
        expect((await fakeBrowser.storage.local.get("blocked.hosts"))["blocked.hosts"]).toEqual([
            "bank.example.com"
        ]);
    });
});
