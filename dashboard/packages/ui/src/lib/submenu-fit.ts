"use client";

/**
 * Where a submenu opens when there is no room beside its menu.
 *
 * Radix opens a submenu to the right of its trigger, or to the left when the
 * right is short, and only ever moves it up and down to keep it on screen. In
 * a window narrower than two menus side by side - a phone, the browser's side
 * panel at its 320 px minimum, a docked chat - neither side fits, and the
 * submenu was drawn half off the screen with nothing to scroll it back.
 *
 * Then it opens over its own menu instead: a step in from the trigger's
 * leading edge and just under it, so the trigger stays readable and the
 * submenu reads as nested. Measured from the trigger when the submenu opens.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

/** The narrowest a dropdown's submenu is drawn, in rem - its `min-w`. */
export const SUBMENU_MIN_REM = 12;

/** How far in from the trigger's leading edge an overlapping submenu starts. */
export const SUBMENU_INDENT = 12;

export interface TriggerBox {
    readonly left: number;
    readonly right: number;
    readonly width: number;
    readonly height: number;
}

export interface SubmenuOffsets {
    readonly sideOffset: number;
    readonly alignOffset: number;
}

/**
 * The offsets that lay a submenu over its menu, or null when it fits beside it
 * on one side or the other and Radix's own placement is right.
 */
export function submenuFit(
    trigger: TriggerBox,
    viewportWidth: number,
    gutter: number,
    need: number
): SubmenuOffsets | null {
    const room = Math.max(viewportWidth - trigger.right - gutter, trigger.left - gutter);
    if (room >= need) return null;
    return { sideOffset: -(trigger.width - SUBMENU_INDENT), alignOffset: trigger.height };
}

interface SubmenuFitState {
    readonly trigger: React.RefObject<HTMLElement | null>;
    readonly offsets: SubmenuOffsets | null;
}

const SubmenuFitContext = createContext<SubmenuFitState | null>(null);

export const SubmenuFitProvider = SubmenuFitContext.Provider;

/** The trigger to measure and the offsets for the submenu, for one `Sub`. */
export function useSubmenuFitRoot(
    gutter: number,
    minRem: number = SUBMENU_MIN_REM
): {
    readonly state: SubmenuFitState;
    readonly measure: (open: boolean) => void;
} {
    const trigger = useRef<HTMLElement | null>(null);
    const [offsets, setOffsets] = useState<SubmenuOffsets | null>(null);
    const measure = useCallback(
        (open: boolean) => {
            const node = trigger.current;
            if (!open || !node) return;
            const view = node.ownerDocument.defaultView;
            if (!view) return;
            const root = view.getComputedStyle(node.ownerDocument.documentElement);
            const rem = Number.parseFloat(root.fontSize) || 16;
            const need = minRem * rem;
            setOffsets(submenuFit(node.getBoundingClientRect(), view.innerWidth, gutter, need));
        },
        [gutter, minRem]
    );
    const state = useMemo(() => ({ trigger, offsets }), [offsets]);
    return { state, measure };
}

/** The trigger's ref, merged with whatever ref the caller passed. */
export function useSubmenuTriggerRef<T extends HTMLElement>(
    forwarded: React.ForwardedRef<T>
): (node: T | null) => void {
    const fit = useContext(SubmenuFitContext);
    return useCallback(
        (node: T | null) => {
            if (fit) fit.trigger.current = node;
            if (typeof forwarded === "function") forwarded(node);
            else if (forwarded) forwarded.current = node;
        },
        [fit, forwarded]
    );
}

/** The offsets for this submenu's content; empty when it fits beside. */
export function useSubmenuOffsets(): Partial<SubmenuOffsets> {
    return useContext(SubmenuFitContext)?.offsets ?? {};
}
