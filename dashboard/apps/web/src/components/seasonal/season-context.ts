"use client";

/**
 * The season the frame decorates with, apart from the frame itself so that the
 * tab icon and Polar can read it without loading the frame's preview controls.
 */

import { createContext, useContext } from "react";
import type * as core from "@polaris/core";

export const SeasonContext = createContext<core.Season | null>(null);

/** The season decorating this frame, or null when there is none or it is off. */
export function useDecorationSeason(): core.Season | null {
    return useContext(SeasonContext);
}
