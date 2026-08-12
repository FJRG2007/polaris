/**
 * The redirects in next.config.mjs against the routes that exist.
 *
 * A redirect is matched before routing, so a source that names a real screen
 * silently shadows it: the page builds, the route is listed, the link is in the
 * rail, and opening it lands somewhere else entirely. That is how the Overview
 * spent its first deploy answering as Drive's, and nothing in a build or a
 * typecheck can see it.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import config from "../../next.config.mjs";
import { describe, expect, it } from "vitest";

const APP_DIR = join(process.cwd(), "src/app");

/** Where a top-level path would be served from, authenticated or not. */
function routeFiles(source: string): string[] {
    const path = source.replace(/^\//, "");
    return ["(app)", "(public)", ""].flatMap((group) =>
        ["page.tsx", "route.ts"].map((file) => join(APP_DIR, group, path, file))
    );
}

describe("next.config redirects", () => {
    it("never claims a path that a screen already answers", async () => {
        const redirects = (await config.redirects?.()) ?? [];
        expect(redirects.length).toBeGreaterThan(0);
        const shadowed = redirects.filter((redirect) => routeFiles(redirect.source).some((file) => existsSync(file)));
        expect(shadowed.map((redirect) => redirect.source)).toEqual([]);
    });

    // The collision above is only recoverable while the redirect is one the
    // browser asks about. A permanent one is a 308 cached with no expiry, so the
    // fix ships and the sessions that already followed it keep landing where it
    // used to point, forever.
    it("is never permanent", async () => {
        const redirects = (await config.redirects?.()) ?? [];
        const permanent = redirects.filter((redirect) => redirect.permanent);
        expect(permanent.map((redirect) => redirect.source)).toEqual([]);
    });
});
