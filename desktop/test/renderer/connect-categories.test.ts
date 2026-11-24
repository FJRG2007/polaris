import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { APP_SETTING_CATEGORIES, APP_SETTINGS } from "@polaris/core/app-settings";

/**
 * The app's own settings page lists the same settings, in the same categories
 * and order, as Settings > This app on the host: each row in the markup names
 * its setting, and the page moves it into its category from the shared schema
 * (`connect.ts`). A setting added to the schema with no row here, or a row
 * naming a setting the schema does not know, fails this.
 */
const page = readFileSync(fileURLToPath(new URL("../../src/renderer/connect.html", import.meta.url)), "utf8");
const named = [...page.matchAll(/data-setting="([^"]+)"/g)].map((match) => match[1] ?? "");
const extras = [...page.matchAll(/data-category="([^"]+)"/g)].map((match) => match[1] ?? "");

describe("the app's own settings page", () => {
    it("has one row for every setting of the shared schema, and none other", () => {
        expect([...named].sort()).toEqual(APP_SETTINGS.map((entry) => entry.key as string).sort());
    });

    it("writes each category's rows in the order the schema lists them", () => {
        for (const category of APP_SETTING_CATEGORIES) {
            const order = APP_SETTINGS.filter((entry) => entry.category === category).map((entry) => entry.key as string);
            expect(named.filter((key) => order.includes(key)), category).toEqual(order);
        }
    });

    it("places everything else under a category the schema has", () => {
        expect(extras.length).toBeGreaterThan(0);
        for (const category of extras) expect(APP_SETTING_CATEGORIES as readonly string[]).toContain(category);
    });
});
