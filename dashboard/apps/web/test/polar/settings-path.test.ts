/** Each settings section is a page of its own. */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { POLAR_SETTINGS_SECTIONS, isSettingsSection, settingsSection } from "@/lib/polar/settings-path";

describe("settings pages", () => {
    it("gives each section its own route", () => {
        expect(settingsSection("routing")).toBe("/polar/settings/routing");
        expect(new Set(POLAR_SETTINGS_SECTIONS).size).toBe(POLAR_SETTINGS_SECTIONS.length);
    });

    it("has a page for every section", () => {
        for (const section of POLAR_SETTINGS_SECTIONS) {
            expect(existsSync(join(process.cwd(), "src/app/(app)/polar/settings", section, "page.tsx"))).toBe(true);
        }
    });

    it("knows its own sections only", () => {
        expect(isSettingsSection("coding-tools")).toBe(true);
        expect(isSettingsSection("constructor")).toBe(false);
        expect(isSettingsSection(null)).toBe(false);
    });
});
