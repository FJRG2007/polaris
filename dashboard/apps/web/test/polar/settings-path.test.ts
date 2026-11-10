/** Each settings section is a page of its own, and the old addresses land on it. */

import { join } from "node:path";
import { existsSync } from "node:fs";
import config from "../../next.config.mjs";
import { describe, expect, it } from "vitest";
import { POLAR_SETTINGS_SECTIONS, isSettingsSection, settingsSection } from "@/lib/polar/settings-path";

describe("settings pages", () => {
    it("gives each section its own route", () => {
        expect(settingsSection("routing")).toBe("/polar/settings/routing");
        expect(new Set(POLAR_SETTINGS_SECTIONS).size).toBe(POLAR_SETTINGS_SECTIONS.length);
    });

    it("sends ?section= to that page, a sign-in to the connectors, and anything else to the first", async () => {
        // A 307 before anything is drawn: a page that only redirects would be
        // answered inside the signed-in group's loading boundary.
        const rules = (await config.redirects()).filter((rule) => rule.source === "/polar/settings");
        const target = (query: Record<string, string>) => {
            const rule = rules.find((candidate) =>
                (candidate.has ?? []).every((condition) => {
                    const value = condition.type === "query" ? query[condition.key] : undefined;
                    // Next anchors the value as `^value$`.
                    return value !== undefined && new RegExp(`^${condition.value}$`).test(value);
                })
            );
            const section = rule?.has?.[0]?.value?.includes("?<section>") ? query.section : undefined;
            return rule?.destination.replace(":section", section ?? ":section");
        };
        expect(target({ section: "permissions" })).toBe("/polar/settings/permissions");
        expect(target({ section: "coding-tools" })).toBe("/polar/settings/coding-tools");
        expect(target({ section: "../admin" })).toBe("/polar/settings/memory");
        expect(target({})).toBe("/polar/settings/memory");
        expect(target({ connector: "signed_in", section: "memory" })).toBe("/polar/settings/connectors");
        expect(target({ connector: "failed" })).toBe("/polar/settings/connectors");
        expect(target({ connector: "<script>" })).toBe("/polar/settings/memory");
    });

    it("lists every section in the redirect, and nothing else", async () => {
        const rule = (await config.redirects()).find((candidate) =>
            candidate.has?.some((condition) => condition.type === "query" && condition.key === "section")
        );
        const listed = /\(\?<section>([^)]*)\)/.exec(rule?.has?.[0]?.value ?? "")?.[1]?.split("|");
        expect(listed).toEqual([...POLAR_SETTINGS_SECTIONS]);
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
