/**
 * Naming a page for the Overview's "Recently visited" card.
 *
 * The rule being protected: a row somebody reads has to say what they were
 * looking at. A raw path does not, an opaque id does not, and neither does a
 * heading that only repeats the section it sits under - so each of those has a
 * fallback, and the fallbacks are what break silently when the navigation
 * registries move.
 */

import { describe, expect, it } from "vitest";
import { describePlace, isRecordablePlace } from "@/lib/overview/place-labels";

describe("isRecordablePlace", () => {
    it("skips the Overview itself, which is where the card is drawn", () => {
        expect(isRecordablePlace("/home")).toBe(false);
        expect(isRecordablePlace("/tasks")).toBe(true);
    });

    it("refuses anything that is not a path inside Polaris", () => {
        expect(isRecordablePlace("https://example.com")).toBe(false);
    });
});

describe("describePlace", () => {
    it("names a fixed screen from the registry, under the app that owns it", () => {
        expect(describePlace("/watch/servers")).toEqual({ label: "Servers", context: "Watch" });
    });

    it("names an app's landing page as the app", () => {
        expect(describePlace("/tasks")).toEqual({ label: "My work", context: "Tasks" });
    });

    it("prefers the page's own heading, and says where it sits", () => {
        expect(describePlace("/apps/deploy/0192f3a1-2b6b-4a4b-9f0e-1c2d3e4f5a6b", "Polaris API")).toEqual({
            label: "Polaris API",
            context: "Apps / Deploy"
        });
    });

    it("ignores a heading that only repeats the section's own name", () => {
        expect(describePlace("/watch/servers", "Servers")).toEqual({ label: "Servers", context: "Watch" });
    });

    it("falls back to the section when the last segment is an id and no heading was drawn", () => {
        expect(describePlace("/apps/deploy/0192f3a1-2b6b-4a4b-9f0e-1c2d3e4f5a6b")).toEqual({
            label: "Deploy",
            context: "Apps"
        });
    });

    it("humanizes a screen neither registry knows, rather than dropping it", () => {
        expect(describePlace("/drive/drop-points/new")).toEqual({ label: "New", context: "Drive / Drop points" });
    });
});
