"use client";

/**
 * What the reader may do with the UPS on screen: run it, drive it, or only
 * watch it. Handed down once, so every panel hides what is not theirs to press
 * instead of offering it and answering with a refusal.
 */

import { createContext, useContext } from "react";
import { whereNow, type ReportedLocation } from "@polaris/core";

export interface UpsReaderStanding {
    readonly manage: boolean;
    readonly control: boolean;
}

export const UpsStandingContext = createContext<UpsReaderStanding>({
    manage: true,
    control: true
});

export function useUpsStanding(): UpsReaderStanding {
    return useContext(UpsStandingContext);
}

/** The reasons an act fenced to the UPS's place was refused. */
const NEARBY = ["nearbyUnasked", "nearbyFar", "nearbyVague", "nearbyUnplaced"] as const;
type NearbyError = (typeof NEARBY)[number];

/**
 * Call a UPS action that a visitor's grant may fence to the place. The server
 * answers "near the place only" first; then, and only then, the browser is
 * asked where it is and the call is made once more.
 */
export async function fencedCall<T extends { ok: boolean; error?: string }>(
    call: (where?: ReportedLocation) => Promise<T>
): Promise<T> {
    const first = await call();
    if (first.ok || first.error !== "nearbyUnasked") return first;
    const where = await whereNow();
    return where ? call(where) : first;
}

/** The error key a failed UPS action is said with. */
export function upsErrorKey(error: string | undefined): "notFound" | "failed" | NearbyError {
    if (error === "notFound") return "notFound";
    return (NEARBY as readonly string[]).includes(error ?? "") ? (error as NearbyError) : "failed";
}
