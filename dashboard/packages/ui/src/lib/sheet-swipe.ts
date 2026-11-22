"use client";

/**
 * Pull a bottom sheet down to close it, from anywhere on it - not only by its
 * handle - the way a phone's own sheets close.
 *
 * Follows Vaul (emilkowalski/vaul) and UIKit's sheet presentation: the finger
 * may land anywhere, and the gesture is the sheet's only when it is clearly a
 * pull downwards with nothing above it to scroll back to.
 *
 * **What it leaves alone.** Only a finger: a mouse drag selects text. A press on
 * a field, a slider, a player, an iframe, inside a selection, or on something
 * that declares its own gesture with `touch-action` (`none` or `pan-x` - a
 * canvas, a slider) is someone else's, and so is anything marked
 * `data-sheet-swipe="off"`. A press inside a list that is scrolled down is that
 * list's: the pull scrolls it back up and the sheet stays where it is - the
 * gesture is decided when the finger lands, so a scroll that reaches the top
 * never turns into a close halfway through. A move that is mostly sideways (a
 * row of reactions that scrolls, a swipe on a row) or starts upwards (a scroll
 * down the list) is let go for the rest of the touch.
 *
 * **Letting go.** Pulled past a quarter of its height (at most `DISMISS_MAX`),
 * or flicked down, the sheet slides the rest of the way and closes the way
 * Escape closes it - so a dialog that refuses Escape (unsaved changes) refuses
 * this too, and the sheet comes back. Anything short of that, or a finger
 * moving back up as it lifts, puts the sheet back. Pushed above where it rests
 * it gives a little and no more. With reduced motion asked for, the sheet still
 * follows the finger but settles without animating.
 *
 * The rules live in `createSheetSwipe`, a state machine with no DOM in it,
 * which is what the tests drive. Moves are written straight to the sheet's
 * style: a re-render per touch move is a gesture that stutters.
 */

/** How far the finger travels before the gesture decides which way it is going. */
export const SHEET_DECIDE_AT = 8;

/** How much more downwards than sideways a move has to be to be this gesture. */
export const SHEET_LOCK_RATIO = 1.2;

/** How much of the sheet's height a slow pull has to cover to close it. */
export const DISMISS_FRACTION = 0.25;

/** The furthest a slow pull ever has to go, so a tall sheet is not a long haul. */
export const DISMISS_MAX = 160;

/** How fast a flick has to be, in pixels per millisecond, to close from anywhere. */
export const FLICK_VELOCITY = 0.4;

/** How far a flick has to have moved the sheet, so a twitch is not a close. */
export const FLICK_MIN = 24;

/** How long the sheet takes to finish leaving, and to come back. */
const LEAVE_MS = 200;
const RETURN_MS = 260;

/** One reading of the finger: where, and when in milliseconds. */
export interface SheetSample {
    readonly x: number;
    readonly y: number;
    readonly t: number;
}

/** What the machine asks of the sheet. */
export interface SheetSwipeOutput {
    /** The sheet's height. */
    readonly height: () => number;
    /** Put the sheet `offset` pixels down (negative: up), following the finger. */
    readonly draw: (offset: number) => void;
    /** The gesture is over: finish leaving and close, or come back. */
    readonly finish: (close: boolean, offset: number) => void;
}

export type SheetSwipePhase = "idle" | "pending" | "dragging";

/** Which way a press that has moved this far is going. Pure. */
export function sheetAxis(dx: number, dy: number): "undecided" | "dismiss" | "other" {
    if (Math.hypot(dx, dy) < SHEET_DECIDE_AT) return "undecided";
    return dy > 0 && dy > Math.abs(dx) * SHEET_LOCK_RATIO ? "dismiss" : "other";
}

/** Whether a sheet `height` tall, let go `offset` pixels down at `velocity`
 *  (pixels per millisecond, positive downwards), closes. Pure. */
export function sheetCloses(offset: number, velocity: number, height: number): boolean {
    if (offset <= 0) return false;
    if (velocity >= FLICK_VELOCITY && offset >= FLICK_MIN) return true;
    // Far enough down, unless the finger was on its way back up when it lifted.
    return offset >= Math.min(height * DISMISS_FRACTION, DISMISS_MAX) && velocity > -0.1;
}

/** How far the sheet moves for a finger `dy` from where the drag locked: one to
 *  one downwards, a stiff and bounded give upwards. Pure. */
export function sheetOffset(dy: number): number {
    if (dy >= 0) return dy;
    return -Math.min(-dy, Math.sqrt(-dy) * 2.5);
}

/**
 * The gesture: idle -> pending (a finger is down, direction unknown) ->
 * dragging -> idle. `move` and `end` return whether the browser's default for
 * that event has to be stopped.
 */
export function createSheetSwipe(output: SheetSwipeOutput) {
    let phase: SheetSwipePhase = "idle";
    let start: SheetSample = { x: 0, y: 0, t: 0 };
    let recent: SheetSample[] = [];
    let offset = 0;

    const reset = (): void => {
        phase = "idle";
        recent = [];
        offset = 0;
    };

    /** Speed downwards over the last tenth of a second of moves. */
    const velocity = (): number => {
        if (recent.length < 2) return 0;
        const last = recent[recent.length - 1]!;
        const first = recent.find((sample) => last.t - sample.t <= 100) ?? recent[0]!;
        const elapsed = last.t - first.t;
        return elapsed > 0 ? (last.y - first.y) / elapsed : 0;
    };

    return {
        get phase(): SheetSwipePhase {
            return phase;
        },

        /** A finger landed where this gesture may take it. */
        start(sample: SheetSample): void {
            if (phase === "dragging") output.finish(false, offset);
            reset();
            phase = "pending";
            start = sample;
            recent = [sample];
        },

        /** The finger moved. `cancelable` is false once the browser has taken
         *  the touch for a scroll of its own, and then it is not this gesture. */
        move(sample: SheetSample, cancelable: boolean): boolean {
            if (phase === "idle") return false;
            if (phase === "pending") {
                const axis = sheetAxis(sample.x - start.x, sample.y - start.y);
                if (axis === "undecided") return false;
                if (axis === "other" || !cancelable) {
                    reset();
                    return false;
                }
                phase = "dragging";
                // Measured from where it locked, so the sheet does not jump by
                // the distance it took to decide.
                start = sample;
            }
            recent.push(sample);
            if (recent.length > 8) recent.shift();
            offset = sheetOffset(sample.y - start.y);
            output.draw(offset);
            return true;
        },

        /** The finger lifted. */
        end(): boolean {
            if (phase !== "dragging") {
                reset();
                return false;
            }
            const moved = offset;
            const close = sheetCloses(moved, velocity(), output.height());
            reset();
            output.finish(close, moved);
            // A drag's lift is not also a tap on whatever it started on.
            return true;
        },

        /** The system took the touch away, or a second finger landed. Never closes. */
        cancel(): void {
            if (phase === "dragging") {
                const moved = offset;
                reset();
                output.finish(false, moved);
            } else reset();
        }
    };
}

const FIELDS =
    "input, textarea, select, [contenteditable=''], [contenteditable='true'], iframe, video, audio, [role='slider'], [data-sheet-swipe='off']";

/** Where a sheet laid out for a phone is one (`DialogContent`'s `sheet`). */
const PHONE = "(max-width: 639px)";

function reducedMotion(): boolean {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** Whether a press on `target` inside `sheet` belongs to something else. */
export function heldElsewhere(target: Element, sheet: HTMLElement): boolean {
    if (target.closest(FIELDS)) return true;
    const selection = window.getSelection?.();
    if (selection && !selection.isCollapsed && selection.toString() !== "") return true;
    for (let node: Element | null = target; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        // A list scrolled down: the pull is its way back up.
        if (
            node.scrollTop > 0 &&
            node.scrollHeight > node.clientHeight + 1 &&
            (style.overflowY === "auto" || style.overflowY === "scroll")
        ) {
            return true;
        }
        // Something with a gesture of its own that is not a vertical pan.
        const action = style.touchAction ?? "";
        const sideways = action.includes("pan-x") && !action.includes("pan-y");
        if (action === "none" || action === "pinch-zoom" || sideways) return true;
        if (node === sheet) break;
    }
    return false;
}

/**
 * Pull-to-close on `sheet`, the element a Radix dialog draws. `phoneOnly` keeps
 * it to a phone-sized window, where a dialog laid out as a sheet is one. Returns
 * the detach.
 */
export function attachSheetSwipe(sheet: HTMLElement, phoneOnly: boolean): () => void {
    let finger = -1;
    let timer = 0;

    const clear = () => {
        sheet.style.transition = "";
        sheet.style.transform = "";
        sheet.style.willChange = "";
    };

    const comeBack = () => {
        const still = reducedMotion();
        sheet.style.animation = "";
        sheet.style.transition = still ? "none" : `transform ${RETURN_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
        sheet.style.transform = "";
        window.clearTimeout(timer);
        timer = window.setTimeout(clear, still ? 0 : RETURN_MS);
    };

    const machine = createSheetSwipe({
        height: () => sheet.getBoundingClientRect().height || window.innerHeight,
        draw: (offset) => {
            window.clearTimeout(timer);
            sheet.style.transition = "none";
            sheet.style.willChange = "transform";
            sheet.style.transform = `translateY(${offset}px)`;
        },
        finish: (close, offset) => {
            if (!close) {
                comeBack();
                return;
            }
            const height = sheet.getBoundingClientRect().height || window.innerHeight;
            const left = reducedMotion()
                ? 0
                : Math.round(LEAVE_MS * (1 - Math.min(1, offset / height) * 0.5));
            sheet.style.transition = left ? `transform ${left}ms cubic-bezier(0.3, 0.6, 0.4, 1)` : "none";
            sheet.style.transform = `translateY(${height}px)`;
            window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                // Its own exit animation would start from where it rests, not
                // from off the edge where the pull left it.
                sheet.style.animation = "none";
                sheet.dispatchEvent(
                    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
                );
                // A dialog that refused to close (unsaved changes) comes back.
                timer = window.setTimeout(() => {
                    if (sheet.isConnected && sheet.getAttribute("data-state") !== "closed") comeBack();
                }, 60);
            }, left);
        }
    });

    const sample = (touch: Touch, event: Event): SheetSample => ({
        x: touch.clientX,
        y: touch.clientY,
        t: event.timeStamp
    });

    const onStart = (event: TouchEvent) => {
        if (event.touches.length !== 1) {
            machine.cancel();
            return;
        }
        const target = event.target instanceof Element ? event.target : null;
        if (
            !target ||
            (phoneOnly && window.matchMedia?.(PHONE).matches !== true) ||
            heldElsewhere(target, sheet)
        ) {
            machine.cancel();
            return;
        }
        finger = event.touches[0]!.identifier;
        machine.start(sample(event.touches[0]!, event));
    };
    const onMove = (event: TouchEvent) => {
        if (machine.phase === "idle") return;
        const touch = Array.from(event.touches).find((each) => each.identifier === finger);
        if (!touch || event.touches.length !== 1) {
            machine.cancel();
            return;
        }
        if (machine.move(sample(touch, event), event.cancelable) && event.cancelable) {
            event.preventDefault();
        }
    };
    const onEnd = (event: TouchEvent) => {
        if (machine.phase === "idle") return;
        if (event.touches.length > 0) {
            machine.cancel();
            return;
        }
        if (machine.end() && event.cancelable) event.preventDefault();
    };
    const onCancel = () => machine.cancel();

    sheet.addEventListener("touchstart", onStart, { passive: true });
    sheet.addEventListener("touchmove", onMove, { passive: false });
    sheet.addEventListener("touchend", onEnd, { passive: false });
    sheet.addEventListener("touchcancel", onCancel);
    return () => {
        sheet.removeEventListener("touchstart", onStart);
        sheet.removeEventListener("touchmove", onMove);
        sheet.removeEventListener("touchend", onEnd);
        sheet.removeEventListener("touchcancel", onCancel);
        machine.cancel();
        window.clearTimeout(timer);
        clear();
    };
}
