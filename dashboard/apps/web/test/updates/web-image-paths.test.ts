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
import { NOT_SHIPPED, rebuildsWebImage, WEB_IMAGE_PATHS } from "../../src/lib/update-service";

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

/** The filter as one pattern: every app under `dashboard/apps` but the ones it
 *  excludes, then the rest of what it names. */
function workflowWebFilter(): string {
    const text = readFileSync(WORKFLOW, "utf8");
    const rest = text.match(/ships '([^']+)' && web=true/);
    const excluded = text.match(/grep -qvE '\^dashboard\/apps\/\(([\w|-]+)\)\/' && web=true/);
    if (!rest || !excluded) throw new Error("the web filter was not found in dashboard-publish.yml");
    return `^dashboard/apps/(?!(?:${excluded[1]})/)|${rest[1]}`;
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

    it("counts every app package but those that ship on their own", () => {
        expect(WEB_IMAGE_PATHS.test("dashboard/apps/places/src/lib/places-extension.ts")).toBe(true);
        expect(WEB_IMAGE_PATHS.test("dashboard/apps/game-servers/package.json")).toBe(true);
        expect(WEB_IMAGE_PATHS.test("dashboard/apps/extension/src/popup.tsx")).toBe(false);
        // The public website, the companion and the Stream Deck plugin: none is
        // in the image, so a change to one offers no deployment an update.
        expect(WEB_IMAGE_PATHS.test("dashboard/apps/site/src/views/docs.tsx")).toBe(false);
        expect(WEB_IMAGE_PATHS.test("dashboard/apps/companion/package.json")).toBe(false);
        expect(WEB_IMAGE_PATHS.test("dashboard/apps/streamdeck/src/plugin.ts")).toBe(false);
        expect(WEB_IMAGE_PATHS.test("dashboard/apps/sites-of-mine/x.ts")).toBe(true);
    });

    it("counts nothing a device plugin release changes", () => {
        // A plugin installs and updates from the desktop app; its package, its
        // native crate and the shared Cargo.lock bump are no dashboard update.
        for (const file of ["clients/device-plugins/hercules-stream100/manifest.json", "crates/polaris-stream100/Cargo.toml", "crates/polaris-stream100-node/src/lib.rs", "Cargo.lock"])
            expect(WEB_IMAGE_PATHS.test(file)).toBe(false);
    });

    it("rebuilds the daemons for a Cargo.lock change only when it reaches them", () => {
        const text = readFileSync(WORKFLOW, "utf8");
        const gates = text.split("\n").filter((line) => /&& out (hostd|tunnel) true/.test(line));
        expect(gates).toHaveLength(2);
        for (const gate of gates) {
            expect(gate).not.toContain("Cargo\\.(toml|lock)");
            expect(gate).not.toContain("Cargo\\.lock");
            expect(gate).toMatch(/lock_reaches polaris-(hostd|tunnel)/);
        }
    });
});

describe("NOT_SHIPPED", () => {
    it("is the workflow's own list of what ships in no image", () => {
        const text = readFileSync(WORKFLOW, "utf8");
        const pattern = text.match(/NOT_SHIPPED='([^']+)'/);
        expect(pattern).not.toBeNull();
        expect(NOT_SHIPPED.source.replace(/\\\//g, "/")).toBe(pattern![1]);
    });

    it("offers no update for a change to nothing but tests", () => {
        for (const file of [
            "dashboard/apps/web/test/updates/web-image-paths.test.ts",
            "dashboard/packages/core/test/changelog.test.ts",
            "dashboard/packages/core/src/access-grants.test.ts",
            "dashboard/apps/web/vitest.config.ts",
            "dashboard/scripts/test/readme-media.test.mjs",
            "crates/polaris-core/tests/vectors.rs"
        ])
            expect(rebuildsWebImage(file)).toBe(false);
    });

    it("still counts the sources beside them, a route called test included", () => {
        for (const file of [
            "dashboard/apps/web/src/app/api/polar/connectors/[id]/test/route.ts",
            "dashboard/packages/core/src/changelog.ts",
            "crates/polaris-core/src/lib.rs",
            "dashboard/apps/hospitality/src/lib/catalog.ts"
        ])
            expect(rebuildsWebImage(file)).toBe(true);
    });
});
