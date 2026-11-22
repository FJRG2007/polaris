"use client";

/**
 * How a viewer likes their terminal - filling the window, the extra keys shown -
 * remembered on this browser, and whether the terminal is shown full screen
 * right now. Several components read it (the dialog sizes itself, the panel
 * shows its key bar), so a write merges into what is stored instead of
 * replacing it.
 */

import { useCallback, useEffect, useState } from "react";
import {
    DEFAULT_TERMINAL_LAYOUT,
    TERMINAL_LAYOUT_KEY,
    parseTerminalLayout,
    type TerminalLayout
} from "@/lib/terminal-keys";

/** The dialog's classes while the terminal fills the window: the whole
 *  viewport on every screen, placed itself (`translate-x-0`) so the phone
 *  sheet layout leaves it alone. */
export const MAXIMIZED_DIALOG =
    "left-0 top-0 flex h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 flex-col rounded-none border-0 p-3 sm:p-4";

function readStored(): TerminalLayout {
    try {
        return parseTerminalLayout(window.localStorage.getItem(TERMINAL_LAYOUT_KEY));
    } catch {
        return DEFAULT_TERMINAL_LAYOUT;
    }
}

export function useTerminalLayout(): {
    layout: TerminalLayout;
    change: (patch: Partial<TerminalLayout>) => void;
} {
    const [layout, setLayout] = useState<TerminalLayout>(DEFAULT_TERMINAL_LAYOUT);
    useEffect(() => setLayout(readStored()), []);
    const change = useCallback((patch: Partial<TerminalLayout>) => {
        const next = { ...readStored(), ...patch };
        setLayout((current) => ({ ...current, ...patch }));
        try {
            window.localStorage.setItem(TERMINAL_LAYOUT_KEY, JSON.stringify(next));
        } catch {
            // Private window or blocked storage: it holds for this visit only.
        }
    }, []);
    return { layout, change };
}

/** The element shown full screen right now, kept current. */
export function useFullscreenElement(): Element | null {
    const [element, setElement] = useState<Element | null>(null);
    useEffect(() => {
        const update = () => setElement(document.fullscreenElement);
        update();
        document.addEventListener("fullscreenchange", update);
        return () => document.removeEventListener("fullscreenchange", update);
    }, []);
    return element;
}

/** Shows `element` full screen, or leaves full screen. False where the
 *  browser refused or has no Fullscreen API (an iPhone). */
export async function toggleFullscreen(element: Element | null): Promise<boolean> {
    try {
        if (document.fullscreenElement) {
            await document.exitFullscreen();
            return true;
        }
        if (!element || typeof element.requestFullscreen !== "function") return false;
        await element.requestFullscreen();
        return true;
    } catch {
        return false;
    }
}
