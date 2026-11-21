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

/** The season this session is previewing, as the frame drew it. `undefined`
 *  outside a frame, so a reader can tell "no frame" from "no preview". */
export const PreviewContext = createContext<core.Season | null | undefined>(undefined);

/** The season this session is previewing, from the frame: what a control that
 *  starts or stops a preview reads, so it follows a stop made elsewhere. */
export function usePreviewSeason(): core.Season | null | undefined {
    return useContext(PreviewContext);
}
