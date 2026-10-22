/**
 * Polar using this browser, the worker's half: nothing to switch on, a site is
 * used only once the person allowed it (the chat's answer only picks which
 * button the window opens on), only Polar's own tabs and the tab in front are
 * touched, an action approved for one site never lands on another, Stop ends
 * it, and the poll hands answers back to the server it came from.
 */

import { describe, expect, it, vi } from "vitest";
import {
    ON_KEY,
    SITES_KEY,
    MIGRATED_KEY,
    PolarBrowser,
    type BrowserApi
} from "../src/lib/polar-browser";

interface Fake {
    api: BrowserApi;
    store: Record<string, unknown>;
    windows: string[];
    sent: unknown[];
    tabs: Map<number, { url: string; title: string }>;
}

function fake(store: Record<string, unknown> = {}): Fake {
    const tabs = new Map<number, { url: string; title: string }>();
    const windows: string[] = [];
    const sent: unknown[] = [];
    let next = 10;
    const api: BrowserApi = {
        runtime: {
            getURL: (path) => `chrome-extension://x${path}`,
            getPlatformInfo: async () => ({})
        },
        storage: {
            local: {
                get: async (key) => ({ [key]: store[key] }),
                set: async (items) => void Object.assign(store, items)
            }
        },
        tabs: {
            create: async ({ url }) => {
                const id = next++;
                tabs.set(id, { url, title: "Page" });
                return { id, url };
            },
            get: async (id) => {
                const tab = tabs.get(id);
                if (!tab) throw new Error("no tab");
                return { id, ...tab, status: "complete" };
            },
            remove: async (id) => void tabs.delete(id),
            query: async () => (tabs.has(1) ? [{ id: 1, url: tabs.get(1)!.url }] : []),
            goBack: async () => undefined,
            sendMessage: async (_id, message) => {
                sent.push(message);
                const op = (message as { polarAgent: { op: string } }).polarAgent.op;
                if (op === "read") return { ok: true, text: "# Title", truncated: false };
                if (op === "click" || op === "scroll" || op === "key") return { ok: true };
                return { ok: true, elements: [] };
            }
        },
        scripting: { executeScript: async () => [] },
        windows: {
            create: async ({ url }) => {
                windows.push(url);
                return { id: 1 };
            }
        }
    };
    return { api, store, windows, sent, tabs };
}

function worker(env: Fake, fetcher?: typeof fetch): PolarBrowser {
    return new PolarBrowser({
        api: env.api,
        link: async () => ({ origin: "https://polaris.test", token: "t0ken" }),
        say: async (which) => which,
        ...(fetcher ? { fetch: fetcher } : {})
    });
}

/** Answers the grant window as soon as it opens. */
function answering(agent: PolarBrowser, env: Fake, grant: "once" | "always" | "deny"): void {
    const create = env.api.windows!.create;
    env.api.windows!.create = async (options) => {
        const result = await create(options);
        const id = new URL(options.url).searchParams.get("id")!;
        queueMicrotask(() => agent.answer(id, grant));
        return result;
    };
}

describe("Polar using this browser", () => {
    it("needs no switch: the first use of a site asks, with the chat's answer first", async () => {
        const env = fake();
        const agent = worker(env);
        answering(agent, env, "once");
        const opened = await agent.run({
            kind: "open",
            url: "https://github.com/a/b",
            grant: "always"
        });
        expect(opened).toMatchObject({ ok: true });
        expect(env.windows[0]).toContain("site=github.com");
        expect(env.windows[0]).toContain("hint=always");
        // The window's own click decides: "once" stores nothing.
        expect(env.store[SITES_KEY]).toBeUndefined();
    });

    it("carries the old switch over: on keeps its sites, off keeps none", async () => {
        const on = fake({ [ON_KEY]: true, [SITES_KEY]: ["github.com"] });
        await worker(on).migrate();
        expect(on.store[SITES_KEY]).toEqual(["github.com"]);
        const off = fake({ [ON_KEY]: false, [SITES_KEY]: ["github.com"] });
        await worker(off).migrate();
        expect(off.store[SITES_KEY]).toEqual([]);
        expect(off.store[MIGRATED_KEY]).toBe(true);
        // Once only: a site allowed after the carry-over stays.
        off.store[SITES_KEY] = ["x.com"];
        await worker(off).migrate();
        expect(off.store[SITES_KEY]).toEqual(["x.com"]);
    });

    it("scrolls the tab in front once its site is allowed, and asks for it first", async () => {
        const env = fake();
        env.tabs.set(1, { url: "https://x.com/home", title: "Home" });
        const agent = worker(env);
        answering(agent, env, "deny");
        await expect(agent.run({ kind: "scroll", site: "x.com" })).resolves.toEqual({
            ok: false,
            refusal: "site-denied"
        });
        expect(env.sent).toHaveLength(0);
        env.store[SITES_KEY] = ["x.com"];
        await expect(
            agent.run({ kind: "scroll", site: "x.com", direction: "down", amount: 2 })
        ).resolves.toMatchObject({ ok: true, tab: 1, url: "https://x.com/home" });
        expect(env.sent).toContainEqual({
            polarAgent: { op: "scroll", direction: "down", amount: 2 }
        });
    });

    it("refuses the tab in front when it is on another site than the call names", async () => {
        const env = fake({ [SITES_KEY]: ["x.com", "bank.test"] });
        env.tabs.set(1, { url: "https://bank.test/", title: "Bank" });
        await expect(
            worker(env).run({ kind: "key", site: "x.com", keys: "PageDown" })
        ).resolves.toEqual({ ok: false, refusal: "wrong-site" });
        expect(env.sent).toHaveLength(0);
    });

    it("forgets one site without touching the others", async () => {
        const env = fake({ [SITES_KEY]: ["x.com", "github.com"] });
        await worker(env).run({ kind: "forget", site: "x.com" });
        expect(env.store[SITES_KEY]).toEqual(["github.com"]);
    });

    it("asks before using a new site, and opens nothing when told no", async () => {
        const env = fake();
        const agent = worker(env);
        answering(agent, env, "deny");
        await expect(agent.run({ kind: "open", url: "https://github.com/a/b" })).resolves.toEqual({
            ok: false,
            refusal: "site-denied"
        });
        expect(env.windows[0]).toContain("site=github.com");
        expect(env.tabs.size).toBe(0);
    });

    it("remembers a site allowed always and asks no more", async () => {
        const env = fake();
        const agent = worker(env);
        answering(agent, env, "always");
        const opened = await agent.run({ kind: "open", url: "https://github.com/a/b" });
        expect(opened).toMatchObject({ ok: true, url: "https://github.com/a/b" });
        expect(env.store[SITES_KEY]).toEqual(["github.com"]);
        await agent.run({ kind: "open", url: "https://github.com/c/d" });
        expect(env.windows).toHaveLength(1);
    });

    it("reads a tab it opened, and no other", async () => {
        const env = fake({ [SITES_KEY]: ["github.com"] });
        const agent = worker(env);
        const opened = await agent.run({ kind: "open", url: "https://github.com/a/b" });
        const tab = opened.ok ? opened.tab : -1;
        await expect(agent.run({ kind: "read", tab })).resolves.toMatchObject({
            ok: true,
            text: "# Title"
        });
        env.tabs.set(99, { url: "https://mail.test/", title: "Mail" });
        await expect(agent.run({ kind: "read", tab: 99 })).resolves.toEqual({
            ok: false,
            refusal: "unknown-tab"
        });
    });

    it("refuses an action approved for a site the tab has left", async () => {
        const env = fake({ [SITES_KEY]: ["github.com", "evil.test"] });
        const agent = worker(env);
        const opened = await agent.run({ kind: "open", url: "https://github.com/a/b" });
        const tab = opened.ok ? opened.tab : -1;
        env.tabs.set(tab, { url: "https://evil.test/", title: "x" });
        await expect(
            agent.run({ kind: "click", tab, ref: "e1", site: "github.com" })
        ).resolves.toEqual({
            ok: false,
            refusal: "wrong-site"
        });
        expect(env.sent.some((message) => JSON.stringify(message).includes('"click"'))).toBe(false);
    });

    it("stops when the person presses Stop", async () => {
        const env = fake({ [SITES_KEY]: ["github.com"] });
        const agent = worker(env);
        const opened = await agent.run({ kind: "open", url: "https://github.com/a/b" });
        await agent.stop();
        await expect(
            agent.run({ kind: "read", tab: opened.ok ? opened.tab : -1 })
        ).resolves.toEqual({
            ok: false,
            refusal: "stopped"
        });
    });

    it("polls with the connection's token and posts the answer back", async () => {
        const env = fake();
        const calls: { url: string; init: RequestInit | undefined }[] = [];
        let polls = 0;
        const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
            calls.push({ url, init });
            if (url.endsWith("/next")) {
                polls++;
                if (polls === 1) {
                    return new Response(
                        JSON.stringify({ id: "abcdefgh12", command: { kind: "close", tab: 5 } }),
                        {
                            status: 200
                        }
                    );
                }
                // Disconnected: the loop ends.
                return new Response(null, { status: 401 });
            }
            return new Response(null, { status: 204 });
        }) as unknown as typeof fetch;
        await worker(env, fetcher).loop();
        await vi.waitFor(() =>
            expect(calls.some((call) => call.url.endsWith("/result"))).toBe(true)
        );
        const poll = calls[0]!;
        expect(poll.url).toBe("https://polaris.test/api/extension/browser/next");
        expect((poll.init?.headers as Record<string, string>).authorization).toBe("Bearer t0ken");
        expect(poll.init?.credentials).toBe("omit");
        expect((poll.init?.headers as Record<string, string>)["x-polar-sites"]).toBe("");
        const result = calls.find((call) => call.url.endsWith("/result"))!;
        expect(JSON.parse(String(result.init?.body))).toEqual({
            id: "abcdefgh12",
            result: { ok: false, refusal: "unknown-tab" }
        });
    });
});
