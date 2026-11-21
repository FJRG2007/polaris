// @vitest-environment jsdom
/**
 * The season handed to the phone app for its launcher icon: named as the page
 * decorates with it, "" for the plain icon, and never an error in a browser or
 * an app too old to take it.
 */

import { phoneSeasonIcon } from "@/lib/mobile-bridge";
import { afterEach, describe, expect, it } from "vitest";

function installApp(app: Record<string, unknown>) {
    (window as unknown as { polarisMobile: unknown }).polarisMobile = app;
}

afterEach(() => {
    delete (window as unknown as { polarisMobile?: unknown }).polarisMobile;
});

describe("phoneSeasonIcon", () => {
    it("names the season to the app, and asks for the plain icon with none", () => {
        const told: string[] = [];
        installApp({ setSeasonIcon: (season: string) => told.push(season) });
        phoneSeasonIcon("winter");
        phoneSeasonIcon(null);
        expect(told).toEqual(["winter", ""]);
    });

    it("does nothing in a browser or in an app older than the feature", () => {
        expect(() => phoneSeasonIcon("winter")).not.toThrow();
        installApp({ platform: () => "android" });
        expect(() => phoneSeasonIcon("winter")).not.toThrow();
    });

    it("keeps the page running when the app refuses", () => {
        installApp({
            setSeasonIcon: () => {
                throw new Error("refused");
            }
        });
        expect(() => phoneSeasonIcon("halloween")).not.toThrow();
    });
});
