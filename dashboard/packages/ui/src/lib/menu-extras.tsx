"use client";

/**
 * Options the application adds to every right-click menu.
 *
 * A row, a file, a message: each screen draws its own menu, and none of them
 * should have to know that the application can also do something with the
 * text somebody had selected when they right-clicked. So the shell provides a
 * source here and `ContextMenuContent` asks it, once, each time a menu opens -
 * which is the moment the selection is still the one the person meant. An empty
 * answer draws nothing, not even the separator.
 */

import { createContext, useContext, type ReactNode } from "react";

export interface MenuExtra {
    readonly id: string;
    readonly label: string;
    readonly icon?: ReactNode;
    readonly onSelect: () => void;
}

/** Asked when a menu opens; the options to add at its foot. */
export type MenuExtrasSource = () => readonly MenuExtra[];

const MenuExtrasContext = createContext<MenuExtrasSource | null>(null);

export const MenuExtrasProvider = MenuExtrasContext.Provider;

export function useMenuExtrasSource(): MenuExtrasSource | null {
    return useContext(MenuExtrasContext);
}
