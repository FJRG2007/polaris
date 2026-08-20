"use client";

/**
 * Whether the menu surface something is drawn in is on screen right now.
 *
 * A right-click submenu is built once and then kept mounted, hidden rather than
 * rebuilt while it is closed (see `ContextMenuSub`), so anything inside it that
 * has to act when it appears - a field that takes focus, say - cannot use its
 * own mounting to know that it has. Everywhere else a surface exists only while
 * it is open, which is what the default says.
 */

import { createContext, useContext } from "react";

export interface MenuSurfaceState {
    /** Whether the surface is on screen. */
    readonly open: boolean;
    /** Whether it is kept mounted between openings rather than rebuilt. */
    readonly kept: boolean;
}

const MenuSurfaceContext = createContext<MenuSurfaceState>({ open: true, kept: false });

export const MenuSurfaceProvider = MenuSurfaceContext.Provider;

export function useMenuSurface(): MenuSurfaceState {
    return useContext(MenuSurfaceContext);
}
