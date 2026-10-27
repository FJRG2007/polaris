"use client";

/**
 * When the buttons over a picture are drawn.
 *
 * Over a stream they are in the way of the thing being watched, so they come
 * when somebody reaches for them and go again on their own: a mouse moving over
 * the picture brings them, a couple of seconds of stillness takes them away, a
 * tap on a phone - which has no hover to bring them - toggles them, and a key
 * landing on one of them keeps them up for as long as it is there.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** How long the buttons stay after the pointer stops moving. */
export const REVEAL_IDLE_MS = 2500;

/** Put on the buttons' own box, so a tap on one of them is not read as a tap
 *  on the picture that hides them. */
export const TILE_CONTROLS = "data-tile-controls";

export interface RevealControls {
    readonly shown: boolean;
    /** For the picture. */
    readonly frameProps: {
        onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
        onPointerLeave: (event: React.PointerEvent<HTMLElement>) => void;
        onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
    };
    /** For the box the buttons are in. */
    readonly controlsProps: {
        onPointerEnter: () => void;
        onPointerLeave: () => void;
        onFocus: () => void;
        onBlur: (event: React.FocusEvent<HTMLElement>) => void;
    };
}

export function useRevealControls(idleMs = REVEAL_IDLE_MS): RevealControls {
    const [shown, setShown] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** A pointer resting on a button, or a key on one: neither is idle. */
    const held = useRef(false);

    const clear = () => {
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = null;
    };
    const later = useCallback(() => {
        clear();
        timer.current = setTimeout(() => {
            timer.current = null;
            if (!held.current) setShown(false);
        }, idleMs);
    }, [idleMs]);
    const reveal = useCallback(() => {
        setShown(true);
        later();
    }, [later]);
    const hide = () => {
        clear();
        if (!held.current) setShown(false);
    };

    useEffect(() => clear, []);

    return {
        shown,
        frameProps: {
            onPointerMove: (event) => {
                if (event.pointerType !== "touch") reveal();
            },
            onPointerLeave: (event) => {
                if (event.pointerType === "mouse") hide();
            },
            onPointerUp: (event) => {
                if (event.pointerType !== "touch") return;
                const target = event.target as Element | null;
                // A tap on a button is using it, which keeps them up.
                if (target?.closest?.(`[${TILE_CONTROLS}]`)) reveal();
                else if (shown) hide();
                else reveal();
            }
        },
        controlsProps: {
            onPointerEnter: () => {
                held.current = true;
                clear();
                setShown(true);
            },
            onPointerLeave: () => {
                held.current = false;
                later();
            },
            onFocus: () => {
                held.current = true;
                clear();
                setShown(true);
            },
            onBlur: (event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                held.current = false;
                later();
            }
        }
    };
}
