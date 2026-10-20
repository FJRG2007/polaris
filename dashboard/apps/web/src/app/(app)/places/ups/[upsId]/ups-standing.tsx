"use client";

/**
 * What the reader may do with the UPS on screen: run it, drive it, or only
 * watch it. Handed down once, so every panel hides what is not theirs to press
 * instead of offering it and answering with a refusal.
 */

import { createContext, useContext } from "react";

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
