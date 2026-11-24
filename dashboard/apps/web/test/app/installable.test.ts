/**
 * Polaris as an installed app: what the browser is told to install, and a service
 * worker that only ever answers a failed page load. It must never hold a copy of
 * a screen or a redirect - the login handoff replayed from a cache is the loop a
 * tab reopened the next day used to fall into.
 */

import { readdirSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { isGatewayFailure } from "@polaris/core/instance-fallback";
import manifest from "../../src/app/manifest";

vi.mock("@/lib/seasonal-service", () => ({ serverSeason: async () => null }));

const worker = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
const workerSource = worker;

describe("the manifest", () => {
    it("opens Polaris in a window of its own, through the address that picks the start", async () => {
        const app = await manifest();
        expect(app.display).toBe("standalone");
        expect(app.start_url).toBe("/");
        expect(app.icons?.some((icon) => icon.sizes === "any")).toBe(true);
    });

    it("offers the installed app for mailto links, at the address Mail registers", async () => {
        expect((await manifest()).protocol_handlers).toEqual([
            { protocol: "mailto", url: "/mail/compose?url=%s" }
        ]);
    });
});

describe("the service worker", () => {
    const ORIGIN = "https://polaris.test";
    type Answer = { ok: boolean; status: number; redirected: boolean; type: string; headers: Headers; clone(): Answer };
    const answer = (status: number, extra: Partial<Answer> = {}, type = "text/html"): Answer => {
        const made: Answer = {
            ok: status >= 200 && status < 300,
            status,
            redirected: false,
            type: "basic",
            headers: new Headers({ "content-type": type }),
            clone: () => made,
            ...extra
        };
        return made;
    };

    /** The worker run in a sandbox, with caches that can be looked into. */
    function boot(network: (url: string) => Promise<Answer>) {
        const listeners = new Map<string, (event: unknown) => void>();
        const offline = new Response("offline");
        const stores = new Map<string, Map<string, unknown>>();
        const keyOf = (key: string | { url: string }) =>
            typeof key === "string" ? key : new URL(key.url).pathname;
        const store = (name: string) => {
            if (!stores.has(name)) stores.set(name, new Map());
            const entries = stores.get(name)!;
            return {
                match: async (key: string | { url: string }) => entries.get(keyOf(key)),
                put: async (key: string | { url: string }, value: unknown) => void entries.set(keyOf(key), value),
                add: async () => undefined,
                keys: async () => [...entries.keys()].map((path) => ({ url: `${ORIGIN}${path}` })),
                delete: async (key: { url: string }) => entries.delete(keyOf(key))
            };
        };
        runInNewContext(worker, {
            self: {
                location: { origin: ORIGIN },
                addEventListener: (name: string, handler: (event: unknown) => void) => listeners.set(name, handler)
            },
            caches: { match: async () => offline, open: async (name: string) => store(name) },
            fetch: (request: string | { url: string }) => network(typeof request === "string" ? request : request.url),
            Response,
            URL
        });
        const request = async (path: string, mode = "navigate", origin = ORIGIN) => {
            let answered: Promise<unknown> | undefined;
            listeners.get("fetch")?.({
                request: { url: `${origin}${path}`, method: "GET", mode },
                respondWith: (reply: Promise<unknown>) => (answered = reply)
            });
            const value = answered === undefined ? undefined : await answered;
            // Let the copy the worker files on the side land.
            await new Promise((resolve) => setTimeout(resolve, 0));
            return value;
        };
        const kept = () => [...(stores.get("polaris-shell-v1")?.keys() ?? [])];
        const seed = (name: string, path: string, value: unknown) => void (stores.get(name) ?? stores.set(name, new Map()).get(name)!).set(path, value);
        const message = async (data: unknown) => {
            let work: Promise<unknown> | undefined;
            listeners.get("message")?.({ data, waitUntil: (done: Promise<unknown>) => (work = done) });
            await work;
        };
        return { request, kept, offline, seed, message };
    }

    it("answers with the offline page exactly when a gateway speaks for a dead Polaris", async () => {
        for (const status of [200, 401, 404, 500, 501, 502, 503, 504, 505, 519, 520, 530, 531]) {
            const worker = boot(async () => answer(status));
            expect((await worker.request("/login")) === worker.offline, `status ${status}`).toBe(
                isGatewayFailure(status)
            );
            expect(worker.kept(), `status ${status}`).toEqual([]);
        }
    });

    it("keeps an app page that loaded, and uses it only when the network cannot answer", async () => {
        let online = true;
        const page = answer(200);
        const worker = boot(async () => {
            if (!online) throw new TypeError("offline");
            return page;
        });
        expect(await worker.request("/chat/c/1")).toBe(page);
        expect(await worker.request("/notes")).toBe(page);
        expect(worker.kept()).toEqual(["/chat/c/1", "/notes"]);
        online = false;
        expect(await worker.request("/chat/c/1")).toBe(page);
        expect(await worker.request("/notes")).toBe(page);
        expect(await worker.request("/home")).toBe(worker.offline);
    });

    it("falls back to the nearest kept page above, never past the page's own section", async () => {
        let online = true;
        const list = answer(200);
        const worker = boot(async () => {
            if (!online) throw new TypeError("offline");
            return list;
        });
        await worker.request("/notes");
        await worker.request("/home");
        online = false;
        expect(await worker.request("/notes/n1/edit")).toBe(list);
        expect(await worker.request("/tasks/t1")).toBe(worker.offline);
        // A gateway answering for a dead Polaris is the same as no answer.
        online = true;
        const gateway = boot(async (url) => (url.endsWith("/notes") ? list : answer(502)));
        await gateway.request("/notes");
        expect(await gateway.request("/notes/n2")).toBe(list);
    });

    it("keeps the desktop app's settings pages ahead of a visit, and nothing else asked", async () => {
        const loaded: string[] = [];
        let online = true;
        const page = answer(200);
        const worker = boot(async (url) => {
            if (!online) throw new TypeError("offline");
            loaded.push(new URL(url).pathname);
            return url.endsWith("/hosts") ? answer(200, { redirected: true }) : page;
        });
        await worker.request("/account/app/general");
        loaded.length = 0;
        await worker.message({
            type: "keep-pages",
            paths: ["/account/app/general", "/account/app/voice", "/account/app/hosts", "/account/addons", "/account/addons/x", "/notes", "/vault", "https://elsewhere.example/account/app/x", 4]
        });
        // Already kept, a redirect, or not one of those pages: never loaded or never kept.
        expect(loaded).toEqual(["/account/app/voice", "/account/app/hosts", "/account/addons"]);
        expect(worker.kept()).toEqual(["/account/app/general", "/account/app/voice", "/account/addons"]);
        await worker.message({ type: "something-else", paths: ["/account/app/updates"] });
        await worker.message(null);
        expect(worker.kept()).toHaveLength(3);
        online = false;
        expect(await worker.request("/account/app/voice")).toBe(page);
    });

    it("never keeps the Vault, the PIN screen or a page outside the app", async () => {
        const worker = boot(async () => answer(200));
        for (const path of ["/vault", "/vault/items/1", "/app-lock", "/login", "/s/abc", "/f/xyz", "/"]) {
            await worker.request(path);
        }
        expect(worker.kept()).toEqual([]);
    });

    it("keeps a bounded number of pages, the least recently loaded going first", async () => {
        const worker = boot(async () => answer(200));
        const most = Number(/const PAGES_KEPT = (\d+);/.exec(workerSource)?.[1]);
        expect(most).toBeGreaterThan(0);
        for (let at = 0; at < most + 5; at += 1) await worker.request(`/notes/n${at}`);
        // Loading the first one again puts it back last, so it survives.
        await worker.request("/notes/n5");
        await worker.request("/notes/extra");
        const kept = worker.kept();
        expect(kept).toHaveLength(most);
        expect(kept).not.toContain("/notes/n6");
        expect(kept.slice(-2)).toEqual(["/notes/n5", "/notes/extra"]);
    });

    it("keeps every section of the signed-in app but the Vault and the PIN screen", () => {
        const listed = /const KEPT_SECTIONS = \[([^\]]*)\]/.exec(workerSource)?.[1] ?? "";
        const sections = [...listed.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
        const group = new URL("../../src/app/(app)/", import.meta.url);
        const routes = readdirSync(group, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith("("))
            .map((entry) => entry.name)
            .filter((name) => name !== "vault" && name !== "app-lock")
            .sort();
        expect(sections).toEqual(routes);
    });

    it("never keeps a redirect, a refusal, an API answer or another origin's", async () => {
        const worker = boot(async (url) =>
            url.includes("/api/") ? answer(200, {}, "application/json") : url.endsWith("/r") ? answer(200, { redirected: true }) : answer(401)
        );
        await worker.request("/chat/r");
        await worker.request("/chat");
        expect(await worker.request("/api/chat/lists", "cors")).toBeUndefined();
        expect(await worker.request("/chat", "navigate", "https://elsewhere.test")).toBeUndefined();
        expect(worker.kept()).toEqual([]);
    });

    it("keeps a build's files, which never change under their name, and nothing else", async () => {
        const worker = boot(async () => answer(200, {}, "text/javascript"));
        await worker.request("/_next/static/chunks/app.js", "no-cors");
        await worker.request("/favicon.ico", "no-cors");
        expect(worker.kept()).toEqual(["/_next/static/chunks/app.js"]);
        expect(workerSource.match(/\.put\(/g)?.length).toBe(2);
    });

    it("serves an attachment fetched ahead only when the network cannot answer, and never stores one", async () => {
        let online = true;
        const live = answer(200, {}, "image/png");
        const worker = boot(async () => {
            if (!online) throw new TypeError("offline");
            return live;
        });
        const copy = answer(200, {}, "image/png");
        worker.seed("polaris-chat-media", "https://polaris.test/api/chat/attachments/a1", copy);
        expect(await worker.request("/api/chat/attachments/a1", "no-cors")).toBe(live);
        online = false;
        expect(await worker.request("/api/chat/attachments/a1?download=1", "no-cors")).toBe(copy);
        await expect(worker.request("/api/chat/attachments/a2", "no-cors")).rejects.toThrow("offline");
        expect(worker.kept()).toEqual([]);
    });
});
