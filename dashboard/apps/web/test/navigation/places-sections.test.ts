/**
 * Where Places opens, and that the camera screens are still where they were.
 *
 * Entering Places used to land on the camera wall. It lands on the place's
 * Overview now - rooms, summaries and the cameras as one card - with the wall
 * and the camera settings one rail entry, and the screens a bookmark or a
 * notification points at keep their paths (/places/live redirects).
 */

import { describe, expect, it } from "vitest";
import { APP_SECTIONS, isSectionActive } from "@/lib/apps";

const places = APP_SECTIONS.home ?? [];

describe("the Places rail", () => {
    it("starts with the Overview, at the app's own path", () => {
        expect(places[0]).toMatchObject({ label: "Overview", href: "/places" });
    });

    it("has one entry for the wall and the camera settings", () => {
        const byLabel = new Map(places.map((section) => [section.label, section.href]));
        expect(byLabel.has("Live")).toBe(false);
        expect(byLabel.get("Cameras")).toBe("/places/cameras");
        expect(places.filter((section) => section.href.startsWith("/places/live"))).toEqual([]);
        expect(byLabel.get("Events")).toBe("/places/events");
    });

    it("lights the Overview only on the Overview", () => {
        expect(isSectionActive("/places", "/places", places)).toBe(true);
        expect(isSectionActive("/places/cameras", "/places", places)).toBe(false);
    });
});
