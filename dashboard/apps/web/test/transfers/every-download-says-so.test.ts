/**
 * Every route that hands a file back tells the page its download has started.
 *
 * The page cannot see a download: it is a navigation, so the browser takes the
 * address and the page is told nothing at all. The only signal is the cookie the
 * response sets for the ticket in the request - so a route that forgets it leaves
 * the bar in the corner saying "waiting for the server" for two minutes and then
 * apologising, for a file that arrived immediately.
 *
 * That is worse than the silence it replaced, which is why this is a rule over the
 * whole directory rather than a note in a review: the next route that serves a file
 * has to answer the ticket, and the failure is not visible from reading it.
 *
 * Read as source rather than imported, on the same terms as the cron-route rule:
 * importing a route pulls in the database and the storage drivers to check a
 * string.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";

const API = join(process.cwd(), "src/app/api");

/** Every `route.ts` under the API, with its text. */
function routes(directory: string): { path: string; source: string }[] {
    const out: { path: string; source: string }[] = [];
    for (const entry of readdirSync(directory)) {
        const full = join(directory, entry);
        if (statSync(full).isDirectory()) {
            out.push(...routes(full));
            continue;
        }
        if (entry !== "route.ts") continue;
        out.push({
            path: full.slice(API.length + 1).replace(/\\/g, "/"),
            source: readFileSync(full, "utf8")
        });
    }
    return out;
}

/**
 * A route that hands something back as a file to save.
 *
 * Found by the header that says so, because that is the thing that makes a browser
 * save rather than draw: a route with `attachment` in its disposition is a download
 * whatever it is called.
 */
function handsBackAFile(source: string): boolean {
    return /["'][Cc]ontent-[Dd]isposition["']\s*:/.test(source) && /attachment/.test(source);
}

/** Whether it says the download has begun, either through the shared helper or by
 *  setting the cookie itself - Drive's two routes already had their own. */
function saysSo(source: string): boolean {
    return source.includes("downloadTicketHeaders") || source.includes("downloadTicketCookie");
}

/**
 * The ones that are not a person waiting at a screen, with the reason.
 *
 * Faces and banners are not on this list because they are not on the list at all:
 * they are drawn inline and never handed over as a file, so they never match. What
 * needs naming is the route that really does serve an attachment to something that
 * is not a browser with somebody in front of it.
 */
const NOT_DOWNLOADS = new Map<string, string>([
    [
        "system/local-ca/route.ts",
        "this instance's certificate, fetched by a machine being set up rather than by a reader waiting at a screen"
    ]
]);

const serving = routes(API).filter((route) => handsBackAFile(route.source));

describe("what a route does when it hands back a file", () => {
    it("finds the routes at all, so this cannot pass by looking at nothing", () => {
        expect(serving.length).toBeGreaterThanOrEqual(10);
    });

    it.each(serving.filter((route) => !NOT_DOWNLOADS.has(route.path)))(
        "$path says the download has started",
        ({ source }) => {
            expect(saysSo(source)).toBe(true);
        }
    );

    it("keeps the list of what is not a download honest", () => {
        // Every name on that list has to be a route that actually exists and
        // actually serves a file, or it is an exemption for something that has been
        // renamed - which is how a real download quietly stops reporting.
        for (const path of NOT_DOWNLOADS.keys()) {
            expect(serving.map((route) => route.path)).toContain(path);
        }
    });
});
