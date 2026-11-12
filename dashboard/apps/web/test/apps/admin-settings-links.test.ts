/**
 * Management > Platform > Polaris apps > <app> > Settings opens the app's
 * administrator settings, `/admin/apps/<app>/settings`, for every app - never
 * the screen the app draws them on (Translate's `/translate/settings`, which
 * answers nowhere on its own and was where the link used to land).
 */

import { describe, expect, it } from "vitest";
import { catalogApps } from "@/lib/apps/catalog";
import { adminAppSubapp } from "@/lib/apps";
import { appSettingsHref } from "@/lib/apps/app-settings";

describe("an app's settings link under Polaris apps", () => {
    it("is the admin address for every app that has settings", () => {
        for (const app of catalogApps().filter((entry) => entry.settingsAt)) {
            expect(appSettingsHref(app), app.id).toBe(`/admin/apps/${app.id}/settings`);
        }
    });

    it("is never the app's own screen in the app's admin rail", () => {
        for (const app of catalogApps()) {
            const hrefs = adminAppSubapp(app.id).sections.map((section) => section.href);
            for (const href of hrefs) expect(href.startsWith("/admin/apps/"), `${app.id}: ${href}`).toBe(true);
        }
        const translate = adminAppSubapp("translate").sections.map((section) => section.href);
        expect(translate).toContain("/admin/apps/translate/settings");
        expect(translate).not.toContain("/translate/settings");
    });
});
