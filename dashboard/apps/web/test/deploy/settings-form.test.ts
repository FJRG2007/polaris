/**
 * The service Settings tab's two pure rules: a card holds a change only when its
 * values differ from the stored ones (not when a field was touched), and the
 * navigator marks the section being read - the last one even when it is too short
 * to reach the reading line.
 */

import { describe, expect, it } from "vitest";
import {
    activeSection,
    sameSettings,
    withFields
} from "../../src/app/(app)/apps/deploy/settings-form";

describe("sameSettings", () => {
    it("treats a value typed and put back as no change", () => {
        expect(sameSettings({ port: "3000" }, { port: "3000" })).toBe(true);
    });

    it("ignores surrounding spaces, which the save trims anyway", () => {
        expect(sameSettings({ branch: " main " }, { branch: "main" })).toBe(true);
    });

    it("sees a real edit, including a switch and a list", () => {
        expect(sameSettings({ autoDeploy: true }, { autoDeploy: false })).toBe(false);
        expect(sameSettings({ limits: [] }, { limits: [{ average: 20 }] })).toBe(false);
    });

    it("does not depend on key order", () => {
        expect(sameSettings({ a: 1, b: "x" }, { b: "x", a: 1 })).toBe(true);
    });
});

describe("withFields", () => {
    it("sends one card's edits over what is stored for its neighbours", () => {
        const stored = { rootDirectory: "", buildCommand: "pnpm run build" };
        const draft = { rootDirectory: "apps/web", buildCommand: "pnpm build:prod" };
        expect(withFields(stored, draft, ["rootDirectory"])).toEqual({
            rootDirectory: "apps/web",
            buildCommand: "pnpm run build"
        });
    });
});

describe("activeSection", () => {
    const sections = [
        { id: "networking", top: 0 },
        { id: "source", top: 900 },
        { id: "scaling", top: 1800 },
        { id: "danger", top: 2600 }
    ];

    it("marks the first section at the top", () => {
        expect(activeSection(sections, 0, 800, 3000)).toBe("networking");
    });

    it("marks the section whose heading passed the reading line", () => {
        expect(activeSection(sections, 850, 800, 3000)).toBe("source");
        expect(activeSection(sections, 1750, 800, 4000)).toBe("scaling");
    });

    it("marks the last section once the end is reached, however short it is", () => {
        expect(activeSection(sections, 2200, 800, 3000)).toBe("danger");
    });

    it("has nothing to mark without sections", () => {
        expect(activeSection([], 0, 800, 800)).toBeNull();
    });
});
