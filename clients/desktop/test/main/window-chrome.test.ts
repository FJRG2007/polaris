/**
 * How a window the dashboard opens is framed, and who gets the bridge: a
 * screen of the dashboard draws its own title bar; anything else on the
 * Polaris's address - the live preview of an agent's server above all - gets
 * the system's frame and no bridge, so it can be moved and resized.
 */

import { join } from "node:path";
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isDashboardPage, isPolarisFrame, needsForeignTitleBar, popupChrome } from "@/main/navigation";

const SERVER = "https://polaris.example.com";
const PREVIEW = `${SERVER}/api/agents/preview/0f6a8a9d-1111-4222-8333-944445555666/sig/5173/`;

/** The dashboard's route handlers outside `/api`, as paths with every dynamic
 *  segment filled in and every route group dropped. */
function handlersOutsideApi(): string[] {
    const app = join(__dirname, "..", "..", "..", "..", "dashboard", "apps", "web", "src", "app");
    const found: string[] = [];
    const walk = (dir: string, segments: string[]) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (dir === app && entry.name === "api") continue;
                const segment = entry.name.startsWith("(") ? null : entry.name.startsWith("[") ? "x" : entry.name;
                walk(join(dir, entry.name), segment ? [...segments, segment] : segments);
            } else if (/^route\.tsx?$/.test(entry.name)) found.push(`/${segments.join("/")}`);
        }
    };
    walk(app, []);
    return found;
}

/** Handlers that only send the browser on to a screen (or a provider's
 *  round trip), so what the window ends up showing is a screen. */
const REDIRECTS = new Set(["/drive/open", "/edge/authorize", "/oauth/reset"]);

describe("window chrome", () => {
    it("frames the live preview's new tab with the system's own title bar", () => {
        expect(popupChrome(PREVIEW, SERVER)).toBe("native");
        expect(popupChrome(`${PREVIEW}about?tab=1#top`, SERVER)).toBe("native");
    });

    it("keeps the dashboard's own title bar on its screens", () => {
        for (const path of ["/", "/home", "/polar/code/1", "/mail/print/abc", "/office/show/1", "/apical"]) {
            expect(popupChrome(`${SERVER}${path}`, SERVER), path).toBe("overlay");
        }
    });

    it("gives every other route handler the system's frame", () => {
        for (const path of [
            "/api",
            "/api/drive/raw/1",
            "/_next/static/chunk.js",
            "/.well-known/assetlinks.json",
            "/c/token/files/1",
            "/p/token/raw",
            "/cli/polaris.sh",
            "/season-icon/winter.png"
        ]) {
            expect(popupChrome(`${SERVER}${path}`, SERVER), path).toBe("native");
        }
    });

    it("covers every route handler the dashboard has outside /api", () => {
        const handlers = handlersOutsideApi().filter((path) => !REDIRECTS.has(path));
        expect(handlers.length).toBeGreaterThan(0);
        for (const path of handlers) expect(isDashboardPage(`${SERVER}${path}`, SERVER), path).toBe(false);
        for (const path of REDIRECTS) expect(handlersOutsideApi(), path).toContain(path);
    });

    it("is never a dashboard screen off the Polaris's origin", () => {
        expect(isDashboardPage("https://elsewhere.example/home", SERVER)).toBe(false);
        expect(isDashboardPage("http://polaris.example.com/home", SERVER)).toBe(false);
        expect(isDashboardPage("not a url", SERVER)).toBe(false);
    });

    it("gives the band under the window buttons to every page but a screen", () => {
        expect(needsForeignTitleBar(`${SERVER}/home`, SERVER)).toBe(false);
        expect(needsForeignTitleBar(PREVIEW, SERVER)).toBe(true);
        expect(needsForeignTitleBar("https://github.com/login/oauth/authorize", SERVER)).toBe(true);
    });
});

describe("the bridge's frames", () => {
    it("answers a dashboard screen running on the Polaris's origin", () => {
        expect(isPolarisFrame(`${SERVER}/home`, SERVER, SERVER)).toBe(true);
    });

    it("refuses the sandboxed preview served at the Polaris's address", () => {
        // `Content-Security-Policy: sandbox` without allow-same-origin: the URL is
        // the Polaris's, the origin is opaque.
        expect(isPolarisFrame(PREVIEW, "null", SERVER)).toBe(false);
        expect(isPolarisFrame(PREVIEW, SERVER, SERVER)).toBe(false);
        expect(isPolarisFrame(`${SERVER}/home`, "null", SERVER)).toBe(false);
    });

    it("refuses a frame on another origin", () => {
        expect(isPolarisFrame("https://elsewhere.example/home", "https://elsewhere.example", SERVER)).toBe(false);
    });
});
