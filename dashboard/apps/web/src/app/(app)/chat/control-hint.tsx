"use client";

/**
 * A word over a call control: the short warning when somebody talks into a
 * muted microphone.
 *
 * Drawn in a portal so the strip the controls sit in can never clip it, centred
 * over the button, kept inside the window, and flipped below the button where
 * there is no room above. It takes no clicks: it is a label, and the button
 * under it is the thing to press.
 */

import { cn } from "@polaris/ui";
import { createPortal } from "react-dom";
import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";

export interface ControlHintText {
    readonly text: string;
    /** `state` for a standing fact, `warn` for something to act on now,
     *  `speaking` for a voice heard while muted - green, the way it reads in
     *  every call client, since nothing is wrong yet. */
    readonly tone: "state" | "warn" | "speaking";
}

/** Space kept between the hint and the button, and between it and the window. */
const GAP = 6;
const EDGE = 8;

/**
 * Where the hint goes, from the button's box, the hint's own size and the
 * window's. Null when the button is not on screen - a call minimised or
 * scrolled away - where a hint pointing at nothing is worse than none.
 */
export function placeHint(
    button: { left: number; top: number; bottom: number; width: number; height: number },
    hint: { width: number; height: number },
    window: { width: number; height: number }
): { left: number; top: number } | null {
    if (button.width === 0 && button.height === 0) return null;
    if (button.bottom < 0 || button.top > window.height) return null;
    const width = Math.min(hint.width, window.width - EDGE * 2);
    const left = Math.max(
        EDGE,
        Math.min(button.left + button.width / 2 - width / 2, window.width - width - EDGE)
    );
    const above = button.top - GAP - hint.height;
    const top = above >= EDGE ? above : button.bottom + GAP;
    return { left, top };
}

export function ControlHint({
    anchor,
    hint
}: {
    anchor: RefObject<HTMLElement | null>;
    hint: ControlHintText | null;
}) {
    const box = useRef<HTMLDivElement>(null);
    const [at, setAt] = useState<{ left: number; top: number } | null>(null);

    const place = useCallback(() => {
        const button = anchor.current?.getBoundingClientRect();
        const own = box.current?.getBoundingClientRect();
        if (!button || !own) return;
        const next = placeHint(button, own, {
            width: window.innerWidth,
            height: window.innerHeight
        });
        setAt((current) =>
            current && next && current.left === next.left && current.top === next.top
                ? current
                : next
        );
    }, [anchor]);

    const text = hint?.text;
    const tone = hint?.tone;
    useLayoutEffect(() => {
        if (text === undefined) {
            setAt(null);
            return;
        }
        place();
        const observer =
            typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => place());
        if (anchor.current) observer?.observe(anchor.current);
        if (box.current) observer?.observe(box.current);
        window.addEventListener("resize", place);
        window.addEventListener("scroll", place, true);
        return () => {
            observer?.disconnect();
            window.removeEventListener("resize", place);
            window.removeEventListener("scroll", place, true);
        };
    }, [text, tone, anchor, place]);

    if (!hint || typeof document === "undefined") return null;
    return createPortal(
        <div
            ref={box}
            role="status"
            aria-live="polite"
            style={at ? { left: at.left, top: at.top } : { left: 0, top: 0 }}
            className={cn(
                "pointer-events-none fixed z-50 max-w-[min(16rem,calc(100vw-1rem))] truncate rounded-md px-2 py-1 text-xs font-medium shadow-popover",
                // Measured before it is placed, so it is drawn only once it is.
                !at && "invisible",
                hint.tone === "warn"
                    ? "bg-danger-solid text-danger-foreground"
                    : hint.tone === "speaking"
                      ? "bg-success-solid text-success-foreground"
                      : "border border-border-strong bg-elevated text-foreground"
            )}
        >
            {hint.text}
        </div>,
        document.body
    );
}
