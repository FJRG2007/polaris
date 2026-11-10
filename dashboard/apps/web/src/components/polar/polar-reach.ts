"use client";

/**
 * The little of Polar a screen needs to hand it a request - whether this
 * account may use it, and `ask` - without importing the panel.
 *
 * A control that only passes words to Polar ("Build with Polar") is drawn on
 * screens that also render outside the signed-in shell, such as an app's own
 * routes, where there is no Polar and its catalogs are not handed down.
 * `PolarProvider` fills this in; outside it the answer is null, and the
 * control draws nothing.
 *
 * Client-safe.
 */

import { createContext, useContext } from "react";

export interface PolarReach {
    readonly allowed: boolean;
    /** Quotes `text`, types `draft` under it, opens the panel; with `send`, sends it. */
    readonly ask: (text: string, draft?: string, send?: boolean) => void;
}

export const PolarReachContext = createContext<PolarReach | null>(null);

/** Polar for this screen, or null where there is none. */
export function usePolarReach(): PolarReach | null {
    return useContext(PolarReachContext);
}
