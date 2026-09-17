"use client";

/**
 * A panel down the right-hand side of a conversation, with the line that sizes it.
 *
 * The profile, the search, and the chat beside a call were fixed widths while the
 * members and the thread could be dragged, so the same screen had two kinds of
 * side panel. This is the one the rest use: the width is remembered per panel,
 * held to what the row can spare, and put back from the line's right-click menu.
 */

import { cn, ResizeHandle } from "@polaris/ui";
import type { CSSProperties, ReactNode } from "react";
import { resetPaneLayout } from "./pane-preferences";
import { useChatPane, type PaneBounds } from "./use-chat-pane";

/** From which width the panel sits beside the conversation. Below it the panel is
 *  the full width - stacked under a call, or the whole screen - and has no line to
 *  move. `always` is a panel that is only ever drawn beside something. */
type Beside = "always" | "md" | "lg";

const HANDLE: Record<Beside, string> = {
    always: "",
    md: "hidden md:block",
    lg: "hidden lg:block"
};

const WIDTH: Record<Beside, string> = {
    always: "w-[var(--side-pane)]",
    md: "w-full md:w-[var(--side-pane)]",
    lg: "w-full lg:w-[var(--side-pane)]"
};

export function SidePane({
    pane,
    bounds,
    label,
    beside = "always",
    className,
    children
}: {
    /** The name its width is remembered under. */
    pane: string;
    bounds: PaneBounds;
    /** What the line is called to a screen reader. */
    label: string;
    beside?: Beside;
    className?: string;
    children: ReactNode;
}) {
    const { drawn, ceiling, measure, resize, reset, min } = useChatPane(pane, bounds);
    return (
        <>
            <ResizeHandle
                axis="x"
                side="end"
                size={drawn}
                min={min}
                max={ceiling}
                onChange={resize}
                onReset={reset}
                onResetAll={resetPaneLayout}
                label={label}
                className={HANDLE[beside]}
            />
            <aside
                ref={measure}
                style={{ "--side-pane": `${drawn}px` } as CSSProperties}
                className={cn("flex min-h-0 shrink-0 flex-col", WIDTH[beside], className)}
            >
                {children}
            </aside>
        </>
    );
}
