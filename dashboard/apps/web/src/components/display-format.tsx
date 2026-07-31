"use client";

/**
 * The resolved display preferences, handed down from the layout so every client
 * screen writes dates, clocks, temperatures and money the same way without each
 * one fetching them. Outside a provider the built-in defaults apply, so a
 * component rendered on its own still formats rather than crashing.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createDisplayFormat, DISPLAY_DEFAULTS, type DisplayFormat, type DisplayPreferences } from "@polaris/core";

const DisplayPreferencesContext = createContext<DisplayPreferences>(DISPLAY_DEFAULTS);

export function DisplayFormatProvider({
    preferences,
    children
}: {
    preferences: DisplayPreferences;
    children: ReactNode;
}) {
    return (
        <DisplayPreferencesContext.Provider value={preferences}>{children}</DisplayPreferencesContext.Provider>
    );
}

/** The raw choices, for the rare screen that branches on one (a chart axis, an
 *  input's expected order) rather than formatting a value. */
export function useDisplayPreferences(): DisplayPreferences {
    return useContext(DisplayPreferencesContext);
}

/** The formatters bound to the current preferences. */
export function useDisplayFormat(): DisplayFormat {
    const preferences = useDisplayPreferences();
    return useMemo(() => createDisplayFormat(preferences), [preferences]);
}
