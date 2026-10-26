"use client";

/** The other half of [keepFocusOnClose](./menu-focus.ts): a field that a menu put
 *  on the screen has to take focus after the menu, not while it is still there. */

import { useEffect, useRef } from "react";

/** How long after the field is focused a closing menu can still pull focus back.
 *  Long enough for a slow first render and a menu's exit animation, short enough
 *  that nobody has clicked anywhere on purpose yet. */
const SETTLE_MS = 600;

/** Where a menu that is still on screen puts focus when it takes it back. */
const MENU = '[role="menu"], [role="menubar"], [data-radix-popper-content-wrapper]';

/** True when focus leaving `node` went nowhere a person sends it: to the page
 *  itself, or into a menu that is on its way out. */
function stolen(event: FocusEvent): boolean {
    const next = event.relatedTarget;
    return !(next instanceof Element) || next.closest(MENU) !== null;
}

/**
 * Focus a field on mount, a tick later than `autoFocus` would - by then the menu
 * that opened it has usually released focus instead of pulling it straight back.
 * Text is selected so a rename can be typed over. `active` is for a field that
 * renders before it is meant to be typed into.
 *
 * "Usually" is the race this also closes: on a slow render (the first time a page
 * does it, typically) the menu is still there when the field takes focus and takes
 * it back. The callers commit or cancel on blur, so that blur used to throw the row
 * away before anybody could type - a new folder's input vanishing the first time
 * and working the second. For a short while after focusing, a blur that went to
 * nowhere or into a menu is swallowed before React sees it, and focus is put back.
 */
export function useDeferredFocus<T extends HTMLElement>(active = true) {
    const ref = useRef<T>(null);

    useEffect(() => {
        if (!active) return;
        let until = 0;
        let node: T | null = null;
        let retry = 0;
        const claim = () => {
            node = ref.current;
            if (!node) return;
            node.focus();
            if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)
                node.select();
        };
        // Listening on the field itself, so stopping the event here keeps it from
        // ever reaching the root where React dispatches `onBlur`.
        const guard = (event: FocusEvent) => {
            if (Date.now() > until || !stolen(event)) return;
            event.stopPropagation();
            window.clearTimeout(retry);
            retry = window.setTimeout(claim, 0);
        };
        // A key pressed in the field is somebody using it: from then on a blur is
        // theirs (Enter commits by blurring), never a menu's.
        const settle = () => {
            until = 0;
        };
        const timer = window.setTimeout(() => {
            claim();
            // A field that lives inside a menu (its search box) hands focus to the
            // menu's own items on purpose, so it has nothing to guard against.
            if (!node || node.closest(MENU)) return;
            until = Date.now() + SETTLE_MS;
            node.addEventListener("focusout", guard);
            node.addEventListener("keydown", settle);
        }, 0);
        return () => {
            window.clearTimeout(timer);
            window.clearTimeout(retry);
            node?.removeEventListener("focusout", guard);
            node?.removeEventListener("keydown", settle);
        };
    }, [active]);

    return ref;
}
