/**
 * Measuring a page must never slow the page down.
 *
 * The tracker is pasted into somebody else's site, and a site owner who finds
 * that Polaris made their first paint worse removes it and never comes back -
 * so the properties below are not an optimisation, they are the terms on which
 * the script is allowed to exist at all.
 *
 * Asserted against the source rather than by running it: it has no build step
 * and no module boundary on purpose (it is one file served as-is), and what
 * matters here is what the browser is told to do, not what a fake DOM does when
 * it is told. A test that mounted it would pass while the file quietly went back
 * to fetching at default priority.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const TRACKER = new URL("../../public/analytics.js", import.meta.url);
const PANEL = new URL("../../src/app/(app)/apps/analytics/analytics-view.tsx", import.meta.url);

const tracker = await readFile(TRACKER, "utf8");
const panel = await readFile(PANEL, "utf8");

describe("the tracker's own cost", () => {
    it("waits for the browser to be idle before its first beat", () => {
        // The opening beat lands in the same moment as the page's fonts, images
        // and data, and it is the least urgent thing on the wire.
        expect(tracker).toContain("requestIdleCallback");
        expect(tracker).toContain("whenIdle(() => view())");
    });

    it("still reports on a tab that is never idle", () => {
        // A deadline rather than a wish: an idle callback with no timeout on a
        // busy page is a visit that is never counted.
        expect(tracker).toMatch(/requestIdleCallback\(run, \{ timeout: \d+ \}\)/);
        expect(tracker).toContain("setTimeout(run, 0)");
    });

    it("sends behind whatever the page itself is fetching", () => {
        expect(tracker).toContain('priority: "low"');
    });

    it("survives the page being closed, which is the beat worth having", () => {
        expect(tracker).toContain("navigator.sendBeacon");
        expect(tracker).toContain("keepalive: true");
    });

    it("never surfaces a failure on somebody else's site", () => {
        // Every path out of `send` is inside a try, and the fetch has its own
        // catch: an unhandled rejection here is an error in a stranger's console.
        expect(tracker).toContain(".catch(() => {");
        expect(tracker.match(/try \{/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    });
});

describe("the snippet somebody is handed", () => {
    it("defers, and asks the browser to put the page first", () => {
        expect(panel).toContain('<script defer fetchpriority="low"');
    });
});

describe("the screen that reads the numbers", () => {
    it("does not wait for the list of what can be measured", async () => {
        // It walks every project, environment and service the account can reach,
        // and it fills one dropdown. It used to be awaited before the first
        // paint, so opening Analytics waited on it.
        const page = await readFile(
            new URL("../../src/app/(app)/apps/analytics/page.tsx", import.meta.url),
            "utf8"
        );
        expect(page).not.toContain("listProjectScopes");
        expect(panel).toContain("listAnalyticsSitesAction()");
    });

    it("tells an empty account apart from a list that has not arrived", () => {
        // The failure this replaced: a dropdown saying "no services yet" to
        // somebody who has forty, for as long as the query took.
        expect(panel).toContain("services !== null && services.length === 0");
    });
});
