/**
 * What a place can be, and what one looks like on screen.
 *
 * Split from the service because a dialog needs the list of kinds and a screen
 * needs the shape of a place, and the service imports the database - a client
 * component that reaches for either would drag Prisma into the browser bundle,
 * which is a build failure with a stack trace that names none of this.
 *
 * Pure and client-safe.
 */

import { z } from "zod";
import { roundCoordinate, type Coordinate } from "@polaris/core";

/** The kinds, which are only ever a label and an icon. Nothing behaves
 *  differently - they are here because "Warehouse" and "Mum's" read better with
 *  the right symbol beside them. */
export const PLACE_KINDS = ["house", "office", "site", "other"] as const;

export type PlaceKind = (typeof PLACE_KINDS)[number];

export const PLACE_KIND_LABELS: Readonly<Record<PlaceKind, string>> = {
    house: "Home",
    office: "Office",
    site: "Site",
    other: "Somewhere else"
};

/** A place as a screen sees it. */
export interface PlaceView {
    readonly id: string;
    readonly name: string;
    readonly kind: string;
    readonly address: string;
    /** Where it is on the Earth, rounded to about a kilometre, for the sun.
     *  Null until somebody sets it. */
    readonly location: Coordinate | null;
    /** How many cameras are in it, for the switcher and the list. */
    readonly cameras: number;
}

function degrees(min: number, max: number, message: string) {
    return z
        .number({ required_error: message, invalid_type_error: message })
        .finite(message)
        .min(min, message)
        .max(max, message);
}

/**
 * A place's coordinate as it is saved: a latitude and a longitude on the Earth,
 * rounded to 2 decimals (about a kilometre) - by the dialog as it is typed and
 * again by the server, which never keeps more than that. Null clears it. The
 * messages are catalog keys under `placeDialog.errors`.
 */
export const placeLocationSchema = z
    .object({
        latitude: degrees(-90, 90, "placeDialog.errors.latitude"),
        longitude: degrees(-180, 180, "placeDialog.errors.longitude")
    })
    .transform((value) => roundCoordinate(value))
    .nullable();

function degreesOf(value: unknown): unknown {
    if (typeof value !== "string") return value;
    const trimmed = value.trim().replace(",", ".");
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    return Number.isNaN(parsed) ? Number.NaN : parsed;
}

/** What a coordinate is put through before it is checked, in the dialog and on
 *  the server: trimmed, a decimal comma read as a point, numbers from text, and
 *  both fields empty read as "no coordinate". */
export function normalizePlaceLocation(input: unknown): unknown {
    if (!input || typeof input !== "object" || Array.isArray(input)) return input ?? null;
    const raw = input as { latitude?: unknown; longitude?: unknown };
    const latitude = degreesOf(raw.latitude);
    const longitude = degreesOf(raw.longitude);
    if (latitude === undefined && longitude === undefined) return null;
    return { latitude, longitude };
}
