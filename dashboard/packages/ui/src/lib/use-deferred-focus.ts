"use client";

/** The other half of [keepFocusOnClose](./menu-focus.ts): a field that a menu put
 *  on the screen has to take focus after the menu, not while it is still there. */

import { useEffect, useRef } from "react";

/**
 * Focus a field on mount, a tick later than `autoFocus` would - by then the menu
 * that opened it has released focus instead of pulling it straight back. Text is
 * selected so a rename can be typed over. `active` is for a field that renders
 * before it is meant to be typed into.
 */
export function useDeferredFocus<T extends HTMLElement>(active = true) {
    const ref = useRef<T>(null);

    useEffect(() => {
        if (!active) return;
        const timer = window.setTimeout(() => {
            const node = ref.current;
            if (!node) return;
            node.focus();
            if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) node.select();
        }, 0);
        return () => window.clearTimeout(timer);
    }, [active]);

    return ref;
}
