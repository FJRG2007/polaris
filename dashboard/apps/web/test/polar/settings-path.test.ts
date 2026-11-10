/** Each settings section is a page of its own, and the old addresses land on it. */

import { describe, expect, it } from "vitest";
import {
    POLAR_SETTINGS_SECTIONS,
    isSettingsSection,
    legacySettingsTarget,
    settingsSection
} from "@/lib/polar/settings-path";

describe("settings pages", () => {
    it("gives each section its own route", () => {
        expect(settingsSection("routing")).toBe("/polar/settings/routing");
        expect(new Set(POLAR_SETTINGS_SECTIONS).size).toBe(POLAR_SETTINGS_SECTIONS.length);
    });

    it("sends ?section= to that page, and anything unknown or missing to the first", () => {
        expect(legacySettingsTarget({ section: "permissions" })).toBe("/polar/settings/permissions");
        expect(legacySettingsTarget({ section: "../admin" })).toBe("/polar/settings/memory");
        expect(legacySettingsTarget({})).toBe("/polar/settings/memory");
    });

    it("keeps how a connector sign-in went, and drops any other value", () => {
        expect(legacySettingsTarget({ connector: "signed_in", section: "memory" })).toBe(
            "/polar/settings/connectors?connector=signed_in"
        );
        expect(legacySettingsTarget({ connector: "failed" })).toBe(
            "/polar/settings/connectors?connector=failed"
        );
        expect(legacySettingsTarget({ connector: "<script>" })).toBe("/polar/settings/memory");
    });

    it("knows its own sections only", () => {
        expect(isSettingsSection("coding-tools")).toBe(true);
        expect(isSettingsSection("constructor")).toBe(false);
        expect(isSettingsSection(null)).toBe(false);
    });
});
