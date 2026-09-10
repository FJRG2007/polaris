/**
 * Polaris as an installed app: what the browser is told to install, and a service
 * worker that only ever answers a failed page load. It must never hold a copy of
 * a screen or a redirect - the login handoff replayed from a cache is the loop a
 * tab reopened the next day used to fall into.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import manifest from "../../src/app/manifest";

const worker = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");

describe("the manifest", () => {
    it("opens Polaris in a window of its own on the overview", () => {
        const app = manifest();
        expect(app.display).toBe("standalone");
        expect(app.start_url).toBe("/home");
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
        expect(worker).toMatch(/fetch\(event\.request\)\.catch\(/);
    });

    it("stores nothing but the offline page", () => {
        expect(worker.match(/cache\.(add|put|addAll)\(/g)).toEqual(["cache.add("]);
        expect(worker).toContain('const OFFLINE = "/offline.html";');
    });
});
