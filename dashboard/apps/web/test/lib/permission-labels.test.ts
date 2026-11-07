/**
 * Every permission area has an answer for its logo - an app the switcher draws
 * with one, or explicitly none - and the area's install requirement matches the
 * app the switcher only offers once it is installed.
 */

import { describe, expect, it } from "vitest";
import { hasAppLogo } from "@polaris/ui";
import { PERMISSION_META, PERMISSIONS } from "@polaris/core";
import { POLARIS_APPS } from "@/lib/apps";
import { AREA_APPS, areaApp } from "@/lib/permission-labels";

const AREAS = [...new Set(PERMISSIONS.map((permission) => PERMISSION_META[permission].area))];

describe("AREA_APPS", () => {
    it("names every area, with an app that has a logo or explicitly none", () => {
        for (const area of AREAS) {
            expect(Object.hasOwn(AREA_APPS, area), area).toBe(true);
            const app = areaApp(area);
            if (app !== null) expect(hasAppLogo(app), `${area} -> ${app}`).toBe(true);
        }
    });

    it("has no Sharing or Snippets area left", () => {
        expect(AREAS).not.toContain("Sharing");
        expect(AREAS).not.toContain("Snippets");
        expect(Object.keys(AREA_APPS)).not.toContain("Sharing");
        expect(Object.keys(AREA_APPS)).not.toContain("Snippets");
    });

    it("points each area at a switcher app, and none for an unknown area", () => {
        const ids = new Set(POLARIS_APPS.map((app) => app.id));
        for (const app of Object.values(AREA_APPS)) if (app) expect(ids.has(app), app).toBe(true);
        expect(areaApp("Work")).toBeNull();
    });

    it("ties a permission to the same install the switcher waits for", () => {
        for (const permission of PERMISSIONS) {
            const { area, app } = PERMISSION_META[permission];
            const entry = POLARIS_APPS.find((one) => one.id === areaApp(area));
            if (entry?.requiresApp) expect(app, permission).toBe(entry.requiresApp);
        }
    });
});
