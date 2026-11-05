"use client";

/**
 * Where a floating note has to be drawn to be seen.
 *
 * While something is in fullscreen - a camera, a call, a presentation - the
 * browser draws that element and nothing else, whatever any z-index says, so a
 * note portaled to `document.body` is there and invisible. The note goes into
 * the fullscreen element for as long as it is fullscreen, and back to the body
 * after.
 */

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

function currentRoot(): HTMLElement | null {
    if (typeof document === "undefined") return null;
    const full = document.fullscreenElement;
    return full instanceof HTMLElement ? full : document.body;
}

/** The element floating notes are portaled into right now. */
export function useOverlayRoot(): HTMLElement | null {
    const [root, setRoot] = useState<HTMLElement | null>(null);
    useEffect(() => {
        const update = () => setRoot(currentRoot());
        update();
        document.addEventListener("fullscreenchange", update);
        return () => document.removeEventListener("fullscreenchange", update);
    }, []);
    return root;
}

/** Draws its children where a floating note stays visible, fullscreen included. */
export function OverlayPortal({ children }: { children: ReactNode }) {
    const root = useOverlayRoot();
    return root ? createPortal(children, root) : null;
}
