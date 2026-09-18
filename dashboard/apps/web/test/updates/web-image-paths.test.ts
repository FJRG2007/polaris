/**
 * The update card's idea of what rebuilds the web image.
 *
 * `WEB_IMAGE_PATHS` is a hand-kept copy of the `web` filter in
 * dashboard-publish.yml. When the two drift, a commit either publishes an image the
 * card never offers, or the card promises a build that never comes. The workflow
 * also rebuilds everything when it edits itself, which is the one alternative the
 * copy adds on top.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WEB_IMAGE_PATHS } from "../../src/lib/update-service";

const WORKFLOW = join(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "..",
    ".github",
    "workflows",
    "dashboard-publish.yml"
);

/** The filter as one pattern: every app under `dashboard/apps` but the one it
 *  excludes, then the rest of what it names. */
function workflowWebFilter(): string {
    const text = readFileSync(WORKFLOW, "utf8");
    const rest = text.match(/has '([^']+)' && web=true/);
    const excluded = text.match(/grep -qvE '\^dashboard\/apps\/([\w-]+)\/' && web=true/);
    if (!rest || !excluded) throw new Error("the web filter was not found in dashboard-publish.yml");
    return `^dashboard/apps/(?!${excluded[1]}/)|${rest[1]}`;
}

describe("WEB_IMAGE_PATHS", () => {
    it("matches the workflow's web filter plus the workflow file itself", () => {
        const expected = `${workflowWebFilter()}|^\\.github/workflows/dashboard-publish\\.yml$`;
        expect(WEB_IMAGE_PATHS.source.replace(/\\\//g, "/")).toBe(expected);
    });

    it("counts the vendored resources built into the image", () => {
        for (const file of [
            "dashboard/resources/minecraft/paper/build.gradle",
            "dashboard/resources/mcicons/icons/diamond.png",
            "dashboard/resources/arkicons/icons/raptor.png"
        ])
            expect(WEB_IMAGE_PATHS.test(file)).toBe(true);
    });

    it("counts every app package but the browser extension", () => {
        expect(WEB_IMAGE_PATHS.test("dashboard/apps/places/src/lib/places-extension.ts")).toBe(true);
        expect(WEB_IMAGE_PATHS.test("dashboard/apps/game-servers/package.json")).toBe(true);
        expect(WEB_IMAGE_PATHS.test("dashboard/apps/extension/src/popup.tsx")).toBe(false);
    });
});
