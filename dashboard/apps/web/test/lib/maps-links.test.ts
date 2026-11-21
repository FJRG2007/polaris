/**
 * A shared location opens in the maps app the reader uses: Apple Maps on Apple
 * devices, Google Maps elsewhere (the maps app itself on Android), and the
 * distance to it reads "you are here" once the reader is at it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { directionsUrl, distanceMeters, mapsPlatform, placeUrl } from "@/lib/maps-links";

const PLACE = { latitude: 40.416775, longitude: -3.70379 };

afterEach(() => vi.unstubAllGlobals());

describe("the maps app a place opens in", () => {
    it.each([
        ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", "apple"],
        ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)", "apple"],
        ["Mozilla/5.0 (Linux; Android 15; Pixel 9) wv", "google"],
        ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "google"]
    ])("is chosen from %s", (userAgent, platform) => {
        vi.stubGlobal("navigator", { userAgent });
        expect(mapsPlatform()).toBe(platform);
    });

    it("asks for directions to the place", () => {
        expect(directionsUrl(PLACE, "apple")).toBe("https://maps.apple.com/?daddr=40.416775,-3.703790");
        expect(directionsUrl(PLACE, "google")).toBe(
            "https://www.google.com/maps/dir/?api=1&destination=40.416775,-3.703790"
        );
    });

    it("pins the place itself", () => {
        expect(placeUrl(PLACE, "apple")).toBe("https://maps.apple.com/?ll=40.416775,-3.703790&q=40.416775,-3.703790");
        expect(placeUrl(PLACE, "google")).toBe("https://www.google.com/maps/search/?api=1&query=40.416775,-3.703790");
    });
});

describe("the distance to a place", () => {
    it("is zero at the place", () => {
        expect(distanceMeters(PLACE, PLACE)).toBe(0);
    });

    it("is about 505 km from Madrid to Barcelona", () => {
        const km = distanceMeters(PLACE, { latitude: 41.385064, longitude: 2.173404 }) / 1000;
        expect(km).toBeGreaterThan(500);
        expect(km).toBeLessThan(510);
    });
});
