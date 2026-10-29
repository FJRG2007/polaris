"use client";

/**
 * Previous and next in Drive's own preview: the buttons, the arrow keys and a
 * swipe, all moving through the listing's files in the order it shows them.
 *
 * The arrow keys step only while a picture, a video or a sound is open. A
 * document, a sheet or a PDF has its own use for them (the caret, the cells,
 * scrolling the page), and a key pressed in a field, a slider or a playing
 * video's own controls is that control's - see `keyBelongsToTarget`.
 */

import { useEffect, useRef } from "react";
import { viewerKind } from "./viewer/kind";
import { Button, shortcutPressed } from "@polaris/ui";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** How far a finger has to travel sideways, and how little up or down, before a
 *  touch counts as a swipe rather than a scroll or a tap. */
const SWIPE_DISTANCE = 60;
const SWIPE_DRIFT = 40;

/** What answers Left and Right itself: text being edited, and anything that
 *  slides - a media player's seek bar, a zoom. */
const OWNS_ARROW_KEYS = [
    "input",
    "textarea",
    "select",
    "[contenteditable='']",
    "[contenteditable='true']",
    "[role='slider']",
    "[role='textbox']",
    // A focused player seeks with the arrows.
    "video",
    "audio"
].join(", ");

/** Whether a key press belongs to whatever it was pressed in rather than to the
 *  viewer's own Left/Right: a field, an editor, or a control that already
 *  answered it. */
export function keyBelongsToTarget(
    event: Pick<
        ReactKeyboardEvent | KeyboardEvent,
        "defaultPrevented" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "target"
    >
): boolean {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
        return true;
    const target = event.target as HTMLElement | null;
    if (!target || typeof target.closest !== "function") return false;
    return target.closest(OWNS_ARROW_KEYS) !== null;
}

function stepBounds(index: number, count: number) {
    return { canBack: index > 0, canForward: index >= 0 && index < count - 1 };
}

/** The way a key press asks to step, -1 or 1, or 0 when it is not a step key
 *  or belongs to what it was pressed in. */
function keyDirection(event: ReactKeyboardEvent | KeyboardEvent): -1 | 0 | 1 {
    if (keyBelongsToTarget(event)) return 0;
    if (shortcutPressed(event, "viewer.previousFile")) return -1;
    if (shortcutPressed(event, "viewer.nextFile")) return 1;
    return 0;
}

/** The step a key press takes from `index` of `count`: -1, 1, or 0 when it is
 *  not a step key or there is nowhere to go that way. */
export function stepOfKey(
    event: ReactKeyboardEvent | KeyboardEvent,
    index: number,
    count: number
): -1 | 0 | 1 {
    const by = keyDirection(event);
    const { canBack, canForward } = stepBounds(index, count);
    return (by < 0 && canBack) || (by > 0 && canForward) ? by : 0;
}

/** The kinds whose preview has no use of its own for the arrow keys. */
export function arrowsStep(name: string): boolean {
    const kind = viewerKind(name);
    return kind === "image" || kind === "video" || kind === "audio";
}

export function ViewerStepper({
    name,
    index,
    count,
    onStep
}: {
    /** The open file's name, which decides whether the arrow keys are its. */
    readonly name: string;
    /** Zero-based position among the listing's files, or -1. */
    readonly index: number;
    readonly count: number;
    readonly onStep: (by: -1 | 1) => void;
}) {
    const step = useRef(onStep);
    step.current = onStep;

    useEffect(() => {
        if (!arrowsStep(name)) return;
        function onKey(event: KeyboardEvent) {
            // A dialog opened over the preview (share, details) has the keys.
            const target = event.target as HTMLElement | null;
            if (target?.closest?.("[role='dialog'], [role='menu']")) return;
            if (keyDirection(event) === 0) return;
            const by = stepOfKey(event, index, count);
            // Kept from the listing underneath, which may still hold the focus
            // while it is hidden and would move its own cursor with the same key.
            event.preventDefault();
            event.stopPropagation();
            if (by !== 0) step.current(by);
        }
        // Captured, so it is answered before anything on the page sees it.
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [name, index, count]);

    return <StepControls index={index} count={count} onStep={onStep} />;
}

/** The previous and next buttons with the position between them, the same in
 *  every preview that steps. Nothing is drawn for a single file. */
export function StepControls({
    index,
    count,
    onStep
}: {
    /** Zero-based position of the open file, or -1. */
    readonly index: number;
    readonly count: number;
    readonly onStep: (by: -1 | 1) => void;
}) {
    const t = useTranslations("driveViewer");
    if (count < 2 || index < 0) return null;
    const { canBack, canForward } = stepBounds(index, count);
    return (
        <div className="flex items-center gap-0.5">
            <Button
                size="icon"
                variant="ghost"
                aria-label={t("viewer.previousFile")}
                title={t("viewer.previousFile")}
                disabled={!canBack}
                onClick={() => onStep(-1)}
            >
                <ChevronLeft className="size-4 shrink-0" aria-hidden />
            </Button>
            <span
                className="min-w-[3.5rem] text-center text-xs tabular-nums text-muted-foreground"
                aria-live="polite"
            >
                {t("viewer.position", { index: index + 1, count })}
            </span>
            <Button
                size="icon"
                variant="ghost"
                aria-label={t("viewer.nextFile")}
                title={t("viewer.nextFile")}
                disabled={!canForward}
                onClick={() => onStep(1)}
            >
                <ChevronRight className="size-4 shrink-0" aria-hidden />
            </Button>
        </div>
    );
}

/** Touch handlers for the preview: a sideways swipe steps, on the kinds the
 *  arrow keys step on. Anything else - a scroll, a tap, a pinch - is left alone. */
export function useSwipeToStep(name: string, onStep: (by: -1 | 1) => void) {
    const from = useRef<{ x: number; y: number } | null>(null);
    return {
        onTouchStart(event: React.TouchEvent) {
            const touch = event.touches[0];
            from.current =
                event.touches.length === 1 && touch && arrowsStep(name)
                    ? { x: touch.clientX, y: touch.clientY }
                    : null;
        },
        onTouchEnd(event: React.TouchEvent) {
            const touch = event.changedTouches[0];
            const start = from.current;
            from.current = null;
            if (!start || !touch) return;
            const dx = touch.clientX - start.x;
            const dy = touch.clientY - start.y;
            if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dy) > SWIPE_DRIFT) return;
            onStep(dx < 0 ? 1 : -1);
        }
    };
}
