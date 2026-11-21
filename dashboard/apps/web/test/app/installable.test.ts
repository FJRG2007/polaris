/**
 * Polaris as an installed app: what the browser is told to install, and a service
 * worker that only ever answers a failed page load. It must never hold a copy of
 * a screen or a redirect - the login handoff replayed from a cache is the loop a
 * tab reopened the next day used to fall into.
 */

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { isGatewayFailure } from "@polaris/core/instance-fallback";
import manifest from "../../src/app/manifest";

const worker = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
const workerSource = worker;

describe("the manifest", () => {
    it("opens Polaris in a window of its own, through the address that picks the start", () => {
        const app = manifest();
        expect(app.display).toBe("standalone");
        expect(app.start_url).toBe("/");
        expect(app.icons?.some((icon) => icon.sizes === "any")).toBe(true);
    });

    it("offers the installed app for mailto links, at the address Mail registers", () => {
        expect(manifest().protocol_handlers).toEqual([
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
            fetch: (request: { url: string }) => network(request.url),
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
        return { request, kept, offline };
    }

    it("answers with the offline page exactly when a gateway speaks for a dead Polaris", async () => {
        for (const status of [200, 401, 404, 500, 501, 502, 503, 504, 505, 519, 520, 530, 531]) {
            const worker = boot(async () => answer(status));
            expect((await worker.request("/home")) === worker.offline, `status ${status}`).toBe(
                isGatewayFailure(status)
            );
            expect(worker.kept(), `status ${status}`).toEqual([]);
        }
    });

    it("keeps a chat page that loaded, and uses it only when the network cannot answer", async () => {
        let online = true;
        const page = answer(200);
        const worker = boot(async () => {
            if (!online) throw new TypeError("offline");
            return page;
        });
        expect(await worker.request("/chat/c/1")).toBe(page);
        expect(worker.kept()).toEqual(["/chat/c/1"]);
        online = false;
        expect(await worker.request("/chat/c/1")).toBe(page);
        expect(await worker.request("/home")).toBe(worker.offline);
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
});
