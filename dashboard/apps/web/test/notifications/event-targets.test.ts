import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { NOTIFICATION_EVENTS, eventFallbackHref } from "@polaris/core";

/**
 * Every kind of alert opens the place where the reader acts on it. A kind
 * without a target, or one that names a page nobody built, is an alert that
 * opens on nothing - the complaint this guards against.
 */

const APPS = join(__dirname, "..", "..", "..");

/** Every page route, as segment lists, with route groups dropped. */
function pageRoutes(): string[][] {
    const routes: string[][] = [];
    const walk = (dir: string, segments: string[]) => {
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            if (statSync(path).isDirectory()) {
                if (name === "node_modules") continue;
                walk(path, /^\(.*\)$/.test(name) ? segments : [...segments, name]);
            } else if (name === "page.tsx") routes.push(segments);
        }
    };
    walk(join(APPS, "web", "src", "app"), []);
    for (const app of readdirSync(APPS)) {
        const dir = join(APPS, app, "src", "routes");
        try {
            if (statSync(dir).isDirectory()) walk(dir, []);
        } catch {
            // An app with no pages of its own.
        }
    }
    return routes;
}

/** Whether a target pattern lands on a page: brackets match brackets, a catch-all takes the rest. */
function routed(target: string, routes: readonly string[][]): boolean {
    const wanted = target.split("?")[0].split("/").filter(Boolean);
    return routes.some((route) => {
        for (let i = 0; i < route.length; i++) {
            const segment = route[i];
            if (segment.startsWith("[[...")) return true;
            if (segment.startsWith("[...")) return i < wanted.length;
            const part = wanted[i];
            if (part === undefined) return false;
            if (segment.startsWith("[")) {
                if (!part.startsWith("[")) return false;
            } else if (segment !== part) return false;
        }
        return route.length === wanted.length;
    });
}

describe("notification targets", () => {
    const routes = pageRoutes();

    it("finds the pages it checks against", () => {
        expect(routes.length).toBeGreaterThan(100);
    });

    it.each(NOTIFICATION_EVENTS.map((event) => [event.id, event] as const))(
        "%s opens a page that exists",
        (_id, event) => {
            expect(event.target).toMatch(/^\/\S*$/);
            expect(routed(event.target, routes)).toBe(true);
            expect(routed(eventFallbackHref(event), routes)).toBe(true);
        }
    );

    it("falls back to the list an item sits in", () => {
        expect(eventFallbackHref({ target: "/tasks/t/[taskId]" })).toBe("/tasks");
        expect(eventFallbackHref({ target: "/places/ups/[upsId]" })).toBe("/places/ups");
        expect(eventFallbackHref({ target: "/account/sessions" })).toBe("/account/sessions");
    });

    it("rejects a page that does not exist", () => {
        expect(routed("/nowhere/at/all", routes)).toBe(false);
    });
});
