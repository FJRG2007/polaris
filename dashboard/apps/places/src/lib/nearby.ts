/**
 * "Only near the place": a grant fenced to where its door stands.
 *
 * Lock brands draw this fence with the phone - Bluetooth range, or the phone's
 * location at the moment of use. A browser has only the second, through the
 * Geolocation API, and a browser's location can be made up by anybody who
 * wants to. So this is a convenience fence that keeps a forwarded link or a
 * guest at home from opening the door by accident, never a lock: the share
 * dialog says so where the box is ticked.
 *
 * The location is used for this one comparison and never kept. The audit line
 * says whether the act was near, not where it was.
 */

import * as core from "@polaris/core";
import { prisma } from "@polaris/db";
import { HomeError } from "./home-error";

/** Why a fenced act was refused, for the screen to answer: `unasked` means ask
 *  the browser and try again; the rest are said as they are. */
export type NearbyRefused = Exclude<core.NearbyVerdict, "near">;

export const NEARBY_SENTENCES: Record<NearbyRefused, string> = {
    unasked: "This can only be used near the place. Allow your location to go on",
    far: "This can only be used near the place, and you are not there",
    vague: "Your location is not precise enough to tell whether you are near the place",
    unplaced: "The place has no location yet, so this cannot check you are near it"
};

export class NearbyRefusal extends HomeError {
    public constructor(public readonly verdict: NearbyRefused) {
        super(NEARBY_SENTENCES[verdict]);
        this.name = "NearbyRefusal";
    }
}

/**
 * Refuse a fenced act that is not near. Nothing at all for an unfenced grant
 * or a resident (no grant), which is every act there was before fences.
 *
 * @returns whether the act was checked and near, for the audit line.
 */
export async function requireNearby(
    nearbyMeters: number | null | undefined,
    placeId: string | null,
    where: core.ReportedLocation | null
): Promise<boolean> {
    if (!nearbyMeters) return false;
    const place = placeId
        ? await prisma.place.findUnique({
              where: { id: placeId },
              select: { latitude: true, longitude: true }
          })
        : null;
    const verdict = core.nearbyVerdict(place, where, nearbyMeters);
    if (verdict !== "near") throw new NearbyRefusal(verdict);
    return true;
}

/** A location off the wire, or null when none came or it is not one. */
export function reportedLocation(value: unknown): core.ReportedLocation | null {
    const parsed = core.reportedLocationSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}
