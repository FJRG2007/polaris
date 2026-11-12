"use client";

/**
 * Whether this account may use Polar, on its own.
 *
 * `PolarProvider` (`polar-panel.tsx`) sets it from the same check every Polar
 * route makes. Kept apart from that module so a control that only needs the
 * answer - the Improve wand in Chat's composer, say - does not pull the whole
 * of Polar into every screen that draws it. False outside the provider (an
 * embed, a meeting page, a test): the control is simply not drawn.
 */

import { createContext, useContext } from "react";

export const PolarAllowedContext = createContext(false);

export function usePolarAllowed(): boolean {
    return useContext(PolarAllowedContext);
}
