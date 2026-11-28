/**
 * The screens an app declares in its manifest (`sections`): filed with its
 * rail entry so the rail, search and the launcher list them like any app's,
 * in the reader's language; only its own pages, only behind its own
 * permissions, and an app built into the image keeps the sections it has.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/app-bundles/store", () => ({ bundleRoot: () => "/nonexistent-polaris-test" }));

import { APP_SECTIONS } from "@/lib/apps";
import { HOST_API } from "@polaris/app-host/version";
import { navigationEntries } from "@/lib/search/entries";
import { registerRuntimeApps } from "@/lib/apps/runtime-apps";
import { KNOWN_PERMISSIONS } from "@/lib/apps/runtime-catalog";
import { readAppCatalog, runtimeViews } from "@/lib/apps/runtime-catalog-schema";

const bakery = {
    id: "bakery",
    version: "1.0.0",
    hostApi: HOST_API,
    name: { "en-US": "Bakery", "es-ES": "Panaderia" },
    summary: { "en-US": "Run a bakery." },
    description: { "en-US": "Orders and ovens." },
    category: "Productivity",
    nav: { category: "work", permission: "bakery.use" },
    permissions: ["bakery.use", "bakery.manage"],
    permissionDefs: [
        { key: "bakery.use", label: { "en-US": "Take orders" } },
        { key: "bakery.manage", label: { "en-US": "Run the bakery" } }
    ],
    sections: [
        { label: { "en-US": "Ovens", "es-ES": "Hornos" }, path: "/x/bakery/ovens", keywords: [{ "en-US": "bake", "es-ES": "hornear" }] },
        { label: { "en-US": "Till" }, path: "/x/bakery/till", permission: "bakery.manage" },
        // Another app's page, and another app's permission: both left out.
        { label: { "en-US": "Borrowed" }, path: "/x/other/page" },
        { label: { "en-US": "Deploys" }, path: "/x/bakery/deploys", permission: "deploy.manage" }
    ],
    bundle: { file: "bakery.zip", digest: `sha256:${"e".repeat(64)}`, size: 1024 },
    published: "2026-11-28T00:00:00.000Z"
};

const deliver = (apps: unknown[], locale = "en-US") =>
    registerRuntimeApps(
        runtimeViews(readAppCatalog({ schema: 1, kind: "apps", issued: "2026-11-28T00:00:00.000Z", apps }), KNOWN_PERMISSIONS, locale)
    );

afterEach(() => deliver([]));

describe("an app's declared screens", () => {
    it("files only its own pages, behind only its own permissions, in the reader's language", () => {
        deliver([bakery], "es-ES");
        expect(APP_SECTIONS.bakery?.map((section) => [section.label, section.href, section.needs ?? null])).toEqual([
            ["Hornos", "/x/bakery/ovens", null],
            ["Till", "/x/bakery/till", "bakery.manage"]
        ]);
        expect(APP_SECTIONS.bakery?.[0]?.keywords).toEqual(["hornear"]);
    });

    it("lists them in search and the launcher, and they go with the app", () => {
        deliver([bakery]);
        const hrefs = navigationEntries(false, ["bakery"]).map((entry) => entry.href);
        expect(hrefs).toEqual(expect.arrayContaining(["/x/bakery/ovens", "/x/bakery/till"]));
        deliver([]);
        expect(APP_SECTIONS.bakery).toBeUndefined();
    });

    it("never replaces the sections of an app built into the image", () => {
        const before = APP_SECTIONS.drive;
        expect(before?.length).toBeGreaterThan(0);
        deliver([{ ...bakery, id: "drive", sections: [{ label: { "en-US": "Fake" }, path: "/x/drive/fake" }] }]);
        expect(APP_SECTIONS.drive).toBe(before);
    });
});
