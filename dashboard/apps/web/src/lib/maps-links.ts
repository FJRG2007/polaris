/**
 * A place handed to the maps app the reader already uses: Apple Maps on an
 * iPhone, iPad or Mac, Google Maps everywhere else - which on Android is the
 * maps app itself, since the system opens a Google Maps address in it.
 *
 * Only https addresses, both documented as cross-platform links by their
 * makers (Apple's Map Links, Google's Maps URLs), so they pass through the one
 * external-link path every client already has (`openLink`): a new tab in a
 * browser, the system browser or maps app from the desktop and phone apps.
 *
 * Pure apart from `mapsPlatform`, so every address can be checked in a test.
 */

export type MapsPlatform = "apple" | "google";

export interface GeoTarget {
    readonly latitude: number;
    readonly longitude: number;
}

/** The maps this device's people expect, read from the browser. */
export function mapsPlatform(): MapsPlatform {
    if (typeof navigator === "undefined") return "google";
    const agent = navigator.userAgent;
    // An iPad asking for the desktop site says "Macintosh"; either way it has Apple Maps.
    return /iPhone|iPad|iPod|Macintosh|Mac OS X/.test(agent) && !/Android/.test(agent) ? "apple" : "google";
}

function coordinates(target: GeoTarget): string {
    return `${target.latitude.toFixed(6)},${target.longitude.toFixed(6)}`;
}

/** Directions from wherever the reader is to the place. */
export function directionsUrl(target: GeoTarget, platform: MapsPlatform): string {
    const to = coordinates(target);
    return platform === "apple"
        ? `https://maps.apple.com/?daddr=${to}`
        : `https://www.google.com/maps/dir/?api=1&destination=${to}`;
}

/** The place itself, pinned, in the maps app. */
export function placeUrl(target: GeoTarget, platform: MapsPlatform): string {
    const at = coordinates(target);
    return platform === "apple"
        ? `https://maps.apple.com/?ll=${at}&q=${at}`
        : `https://www.google.com/maps/search/?api=1&query=${at}`;
}

/** Metres between two points on the Earth's surface (haversine). */
export function distanceMeters(a: GeoTarget, b: GeoTarget): number {
    const radians = (degrees: number) => (degrees * Math.PI) / 180;
    const dLat = radians(b.latitude - a.latitude);
    const dLon = radians(b.longitude - a.longitude);
    const h =
        Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
    return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}
