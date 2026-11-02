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
    it("answers only page loads, and only when they fail", () => {
        expect(worker).toContain('if (event.request.mode !== "navigate") return;');
        expect(worker).toMatch(/fetch\(event\.request\)\s*\.then\(/);
    });

    it("answers with the offline page exactly when a gateway speaks for a dead Polaris", async () => {
        const offline = new Response("offline");
        const navigate = async (status: number) => {
            const listeners = new Map<string, (event: unknown) => void>();
            const self = {
                addEventListener: (name: string, handler: (event: unknown) => void) =>
                    listeners.set(name, handler)
            };
            runInNewContext(worker, {
                self,
                caches: { match: async () => offline },
                fetch: async () => new Response(null, { status }),
                Response
            });
            let answered: Promise<Response> | undefined;
            listeners.get("fetch")?.({
                request: { mode: "navigate" },
                respondWith: (reply: Promise<Response>) => (answered = reply)
            });
            return (await answered) === offline;
        };
        for (const status of [200, 401, 404, 500, 501, 502, 503, 504, 505, 519, 520, 530, 531]) {
            expect(await navigate(status), `status ${status}`).toBe(isGatewayFailure(status));
        }
    });

    it("stores nothing but the offline page", () => {
        expect(worker.match(/cache\.(add|put|addAll)\(/g)).toEqual(["cache.add("]);
        expect(worker).toContain('const OFFLINE = "/offline.html";');
    });
});
