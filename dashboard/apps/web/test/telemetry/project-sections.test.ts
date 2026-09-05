/**
 * The sections of a telemetry project.
 *
 * Worth asserting for the reason Deploy's are: a section key is a string in a
 * URL, nothing type-checks it, and the failure it causes is a lit rail entry
 * above an empty frame rather than an error anybody sees.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_SECTION, SECTIONS, sectionFor } from "@/app/(app)/apps/telemetry/project-sections";

describe("the sections of a project", () => {
    it("opens on the faults, which is what somebody came for", () => {
        expect(DEFAULT_SECTION).toBe("issues");
        expect(SECTIONS[0]?.key).toBe(DEFAULT_SECTION);
    });

    it("has a key for each, and no two the same", () => {
        const keys = SECTIONS.map((section) => section.key);
        expect(new Set(keys).size).toBe(keys.length);
        for (const section of SECTIONS) {
            expect(section.key).toMatch(/^[a-z]+$/);
            expect(section.label.length).toBeGreaterThan(0);
            expect(section.hint.length).toBeGreaterThan(0);
        }
    });

    it("takes a section a link names", () => {
        expect(sectionFor("client")).toBe("client");
        expect(sectionFor("SETTINGS")).toBe("settings");
        expect(sectionFor(" reporters ")).toBe("reporters");
    });

    it("lands on the faults rather than on nothing", () => {
        // A link with a typo in it is a reader on the wrong screen, not a reader
        // staring at a blank frame with a rail entry lit above it.
        expect(sectionFor("setttings")).toBe(DEFAULT_SECTION);
        expect(sectionFor("")).toBe(DEFAULT_SECTION);
        expect(sectionFor(null)).toBe(DEFAULT_SECTION);
        expect(sectionFor(undefined)).toBe(DEFAULT_SECTION);
    });
});
