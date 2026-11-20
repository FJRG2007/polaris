"use client";

/**
 * Swipe a screen to the right to go back, the way a phone's own apps do: inside
 * a conversation, a task, a folder or a settings page, a finger dragged
 * rightwards carries the screen with it, and letting go far enough along - or
 * flicking it - finishes the slide and goes back to where the screen was opened
 * from. Letting go early, or dragging back, puts the screen where it was.
 *
 * **What "back" is.** Every drill-down screen already has a back control: the
 * arrow at the top of a phone-sized conversation, the link up to a list. The
 * control is marked `data-swipe-back`, and the swipe ends by pressing it - so the
 * gesture goes exactly where the arrow goes, whether that is a link, a router
 * push or a piece of state, and a screen with no back control has no swipe. A
 * control that is not drawn (`md:hidden` on a wide screen) does not count, which
 * is what keeps the gesture to the layouts that actually drill down.
 *
 * **What moves.** The nearest `data-swipe-back-pane` around the control, else
 * the content area itself.
 *
 * **What it leaves alone.** Only a finger: a mouse drag selects text. A press on
 * a field, a slider, a player, an iframe, inside a selection, or in something
 * that scrolls sideways and is not at its start is someone else's. So is a press
 * on an element that declares its own sideways gesture with `touch-action`
 * (`pan-y` or `none` - a message row's swipe to reply), except within
 * `SWIPE_BACK_EDGE` of the screen's edge, which is the back gesture's
 * everywhere. A move that is mostly vertical is a scroll and is let go for the
 * rest of the touch.
 *
 * **The phone apps.** Their own back - iOS's edge swipe through the web view's
 * history, Android's system back - knows nothing about a screen whose back is a
 * piece of state, and history back from a conversation opened from another
 * conversation lands on the first one rather than on the list. So the page tells
 * the app whether it has a back of its own (`polarisMobile.swipeBack`), and the
 * app hands its gesture over while it does: iOS stops its history swipe and
 * leaves the edge to this, and Android's back - its predictive back's progress
 * included - drives this through `window.polarisSwipeBack`. An app that predates
 * this ignores the call, and a page that predates it never makes it; either way
 * the app's own back goes on working as before. Android's back also closes an
 * open dialog or menu first, the way the system back does in a native app.
 *
 * The rules live in `createSwipeBack`, a state machine with no DOM in it, which
 * is what the tests drive. Moves are written straight to the pane's style: a
 * re-render per touch move is a gesture that stutters.
 */

import { useEffect, type RefObject } from "react";

/** How close to the screen's edge a press is the back gesture's whatever it lands on. */
export const SWIPE_BACK_EDGE = 24;

/** How far the finger travels before the gesture decides which way it is going. */
export const DECIDE_AT = 10;

/** How much more sideways than vertical a move has to be to be this gesture. */
export const LOCK_RATIO = 1.5;

/** How far along the screen a slow drag has to be let go to go back. */
export const COMMIT_FRACTION = 0.4;

/** How fast a flick has to be, in pixels per millisecond, to go back from anywhere. */
export const FLING_VELOCITY = 0.4;

/** How long the screen takes to finish leaving, and to come back. */
const LEAVE_MS = 200;
const RETURN_MS = 260;

/** How long a pressed back control has to take the screen away before it is shown again regardless. */
const NAVIGATION_GRACE_MS = 900;

/** One reading of the finger: where, and when in milliseconds. */
export interface SwipeSample {
    readonly x: number;
    readonly y: number;
    readonly t: number;
}

/** What the machine asks of the screen. */
export interface SwipeBackOutput {
    /** The width the screen slides across. */
    readonly width: () => number;
    /** Put the screen `offset` pixels along, following the finger. */
    readonly draw: (offset: number) => void;
    /** The gesture is over: finish leaving and go back, or return. */
    readonly finish: (back: boolean, offset: number) => void;
}

export type SwipeBackPhase = "idle" | "pending" | "swiping" | "driven";

/** Which way a press that has moved this far is going. `sign` is 1 where back
 *  is a swipe to the right and -1 in a right-to-left layout. */
export function swipeAxis(dx: number, dy: number, sign = 1): "undecided" | "back" | "other" {
    const along = dx * sign;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    const travelled = Math.hypot(dx, dy);
    if (travelled < DECIDE_AT) return "undecided";
    if (along > 0 && ax > ay * LOCK_RATIO) return "back";
    if (along <= 0 || ay >= ax || travelled >= DECIDE_AT * 3) return "other";
    return "undecided";
}

/** Whether a gesture let go `offset` pixels along at `velocity` (pixels per
 *  millisecond, positive towards back) on a screen `width` wide goes back. */
export function goesBack(offset: number, velocity: number, width: number): boolean {
    if (offset <= 0) return false;
    if (velocity >= FLING_VELOCITY) return true;
    // Far enough along, unless the finger was on its way back when it lifted.
    return offset >= width * COMMIT_FRACTION && velocity > -0.1;
}

/**
 * The gesture: idle -> pending (a finger is down, direction unknown) ->
 * swiping -> idle, or idle -> driven (the phone app's back is moving it) ->
 * idle. `move` and `end` return whether the browser's default for that event
 * has to be stopped.
 */
export function createSwipeBack(output: SwipeBackOutput) {
    let phase: SwipeBackPhase = "idle";
    let sign = 1;
    let start: SwipeSample = { x: 0, y: 0, t: 0 };
    let recent: SwipeSample[] = [];
    let offset = 0;

    const reset = (): void => {
        phase = "idle";
        recent = [];
        offset = 0;
    };

    /** Speed towards back over the last tenth of a second of moves. */
    const velocity = (): number => {
        if (recent.length < 2) return 0;
        const last = recent[recent.length - 1]!;
        const first = recent.find((sample) => last.t - sample.t <= 100) ?? recent[0]!;
        const elapsed = last.t - first.t;
        return elapsed > 0 ? ((last.x - first.x) * sign) / elapsed : 0;
    };

    const settle = (back: boolean): void => {
        const moved = offset;
        const wasMoving = phase === "swiping" || phase === "driven";
        reset();
        if (wasMoving || back) output.finish(back, moved);
    };

    return {
        get phase(): SwipeBackPhase {
            return phase;
        },

        /** A finger landed where this gesture may take it. */
        start(sample: SwipeSample, direction = 1): void {
            if (phase === "swiping" || phase === "driven") settle(false);
            reset();
            phase = "pending";
            sign = direction;
            start = sample;
            recent = [sample];
        },

        /** The finger moved. `cancelable` is false once the browser has taken
         *  the touch for a scroll, and `claimed` once something under the finger
         *  has taken it for its own gesture; either way it is not this one. */
        move(sample: SwipeSample, cancelable: boolean, claimed = false): boolean {
            if (phase !== "pending" && phase !== "swiping") return false;
            const dx = sample.x - start.x;
            const dy = sample.y - start.y;
            if (phase === "pending") {
                const axis = swipeAxis(dx, dy, sign);
                if (axis === "undecided") return false;
                if (axis === "other" || !cancelable || claimed) {
                    reset();
                    return false;
                }
                phase = "swiping";
                // Measured from where it locked, so the screen does not jump by
                // the distance it took to decide.
                start = { ...sample, y: start.y };
            }
            recent.push(sample);
            if (recent.length > 8) recent.shift();
            offset = Math.min(output.width(), Math.max(0, (sample.x - start.x) * sign));
            output.draw(offset);
            return true;
        },

        /** The finger lifted. */
        end(): boolean {
            if (phase !== "swiping") {
                reset();
                return false;
            }
            settle(goesBack(offset, velocity(), output.width()));
            // A swipe's lift is not also a tap on whatever it started on.
            return true;
        },

        /** The system took the touch away, or something else ended it. Never goes back. */
        cancel(): void {
            if (phase === "pending") reset();
            else if (phase === "swiping") settle(false);
        },

        /** The phone app's back gesture started. */
        begin(): void {
            if (phase === "swiping") settle(false);
            reset();
            phase = "driven";
        },

        /** How far along the app's back gesture is, from 0 to 1. */
        progress(fraction: number): void {
            if (phase !== "driven") return;
            offset = Math.min(1, Math.max(0, fraction)) * output.width();
            output.draw(offset);
        },

        /** The app's back gesture was let go: go back, from wherever it got to. */
        commit(): void {
            if (phase === "swiping") reset();
            phase = "driven";
            settle(true);
        },

        /** The app's back gesture was called off. */
        abandon(): void {
            if (phase === "driven") settle(false);
        }
    };
}

/** What the phone app adds to the page, as far as this goes. */
interface MobileBridge {
    swipeBack?: (available: boolean) => void;
}

/** What the phone app calls on the page while its back gesture is in hand. */
export interface SwipeBackDriver {
    begin(): boolean;
    progress(fraction: number): void;
    cancel(): void;
    commit(): boolean;
}

declare global {
    interface Window {
        polarisSwipeBack?: SwipeBackDriver;
    }
}

const FIELDS =
    "input, textarea, select, [contenteditable=''], [contenteditable='true'], iframe, video, audio, [role='slider']";

/** A dialog open over the page. */
const OPEN_DIALOG = "[role='dialog'][data-state='open'], [role='alertdialog'][data-state='open']";

/** Where a dialog is a screen of its own - the whole phone - and so goes back like one. */
const PHONE = "(max-width: 639px)";

/** A dialog, sheet or menu open over the page, which the app's back closes first. */
const OPEN_LAYER =
    "[role='dialog'][data-state='open'], [role='alertdialog'][data-state='open'], [role='menu'][data-state='open'], [aria-modal='true']";

function shown(element: Element): boolean {
    return element.getClientRects().length > 0;
}

function paneOf(control: Element, root: HTMLElement): HTMLElement {
    const pane = control.closest<HTMLElement>("[data-swipe-back-pane]");
    return pane && root.contains(pane) ? pane : root;
}

/**
 * The back control a swipe starting on `target` would press, and the pane it
 * moves: among the drawn controls whose pane holds the press, the one with the
 * innermost pane. With no target (the app's back), the innermost of all.
 */
export function backControl(
    root: HTMLElement,
    target: Element | null
): { control: HTMLElement; pane: HTMLElement } | null {
    let found: { control: HTMLElement; pane: HTMLElement } | null = null;
    for (const control of root.querySelectorAll<HTMLElement>("[data-swipe-back]")) {
        if (!shown(control) || control.closest("[inert], [aria-hidden='true']")) continue;
        const pane = paneOf(control, root);
        if (target && !pane.contains(target)) continue;
        if (!found || (found.pane !== pane && found.pane.contains(pane))) found = { control, pane };
    }
    return found;
}

/** Whether a press on `target` belongs to something else that moves sideways. */
function ownedElsewhere(target: Element, pane: HTMLElement, x: number, sign: number): boolean {
    if (target.closest(FIELDS)) return true;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString() !== "") return true;
    const atEdge = sign > 0 ? x <= SWIPE_BACK_EDGE : x >= window.innerWidth - SWIPE_BACK_EDGE;
    for (let node: Element | null = target; node && node !== pane.parentElement; node = node.parentElement) {
        const style = getComputedStyle(node);
        // Something that scrolls sideways and has room to go back the way the
        // finger is going.
        if (
            node.scrollWidth > node.clientWidth + 1 &&
            (style.overflowX === "auto" || style.overflowX === "scroll") &&
            Math.abs(node.scrollLeft) > 1
        ) {
            return true;
        }
        if (!atEdge && (style.touchAction === "none" || /pan-y/.test(style.touchAction)) && !/pan-x|manipulation|auto/.test(style.touchAction)) {
            return true;
        }
    }
    return false;
}

/** The open dialog drawn on top, if any. */
function topDialog(): HTMLElement | null {
    const open = document.querySelectorAll<HTMLElement>(OPEN_DIALOG);
    return open.length ? open[open.length - 1]! : null;
}

function phoneSized(): boolean {
    return window.matchMedia?.(PHONE).matches === true;
}

/**
 * Where a gesture starting on `target` is looked for: the dialog it landed in,
 * when that dialog fills a phone; the content area, when nothing is open over
 * it; else nowhere. With no target, the dialog on top or the content area.
 */
export function swipeRoot(main: HTMLElement, target: Element | null): HTMLElement | null {
    const dialog = target ? target.closest<HTMLElement>(OPEN_DIALOG) : topDialog();
    if (dialog) return phoneSized() ? dialog : null;
    if (document.querySelector(OPEN_LAYER)) return null;
    if (target && !main.contains(target)) return null;
    return main;
}

function reducedMotion(): boolean {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function mobileBridge(): MobileBridge | undefined {
    return (window as unknown as { polarisMobile?: MobileBridge }).polarisMobile;
}

/**
 * The gesture for the content area `root`. Mounted once, by the shell.
 */
export function useSwipeBack(root: RefObject<HTMLElement | null>): void {
    useEffect(() => {
        const main = root.current;
        if (!main) return;
        let target: { control: HTMLElement; pane: HTMLElement } | null = null;
        let finger = -1;
        let returning = 0;
        let leaving = 0;
        let watching = 0;

        const clear = (pane: HTMLElement) => {
            pane.style.transition = "";
            pane.style.transform = "";
            pane.style.boxShadow = "";
            pane.style.willChange = "";
            pane.style.opacity = "";
        };

        /** Show the screen again once the back control's press has taken it
         *  away - or after a while, if it never does - fading in rather than
         *  flashing the old screen back before the new one draws. */
        const reappear = (pane: HTMLElement, control: HTMLElement, since: number) => {
            const gone = !control.isConnected || !shown(control);
            if (!gone && performance.now() - since < NAVIGATION_GRACE_MS) {
                watching = requestAnimationFrame(() => reappear(pane, control, since));
                return;
            }
            watching = 0;
            pane.style.transition = "none";
            pane.style.transform = "";
            pane.style.boxShadow = "";
            pane.style.opacity = reducedMotion() ? "" : "0";
            requestAnimationFrame(() => {
                pane.style.transition = reducedMotion() ? "" : "opacity 160ms ease-out";
                pane.style.opacity = "";
                window.setTimeout(() => clear(pane), 200);
            });
        };

        const machine = createSwipeBack({
            width: () => target?.pane.getBoundingClientRect().width || window.innerWidth,
            draw: (offset) => {
                const pane = target?.pane;
                if (!pane) return;
                const sign = direction();
                pane.style.transition = "none";
                pane.style.willChange = "transform";
                pane.style.transform = `translateX(${offset * sign}px)`;
                pane.style.boxShadow = offset > 0 ? `${-8 * sign}px 0 24px rgb(0 0 0 / 0.18)` : "";
            },
            finish: (back, offset) => {
                const current = target;
                target = null;
                if (!current) return;
                const { pane, control } = current;
                const still = reducedMotion();
                window.clearTimeout(returning);
                window.clearTimeout(leaving);
                if (!back) {
                    pane.style.transition = still ? "none" : `transform ${RETURN_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
                    pane.style.transform = "";
                    returning = window.setTimeout(() => clear(pane), still ? 0 : RETURN_MS);
                    return;
                }
                const width = pane.getBoundingClientRect().width || window.innerWidth;
                const left = still ? 0 : Math.round(LEAVE_MS * (1 - Math.min(1, offset / width) * 0.5));
                pane.style.transition = left ? `transform ${left}ms cubic-bezier(0.3, 0.6, 0.4, 1)` : "none";
                pane.style.transform = `translateX(${width * direction()}px)`;
                leaving = window.setTimeout(() => {
                    leaving = 0;
                    // A dialog's own exit animation would start from where it
                    // was opened, not from off the edge where the swipe left it.
                    if (pane.matches(OPEN_DIALOG)) pane.style.animation = "none";
                    control.click();
                    reappear(pane, control, performance.now());
                }, left);
            }
        });

        const direction = () => (getComputedStyle(main).direction === "rtl" ? -1 : 1);
        const sample = (touch: Touch, event: Event): SwipeSample => ({
            x: touch.clientX,
            y: touch.clientY,
            t: event.timeStamp
        });
        const tracked = (list: TouchList): Touch | undefined =>
            Array.from(list).find((touch) => touch.identifier === finger);

        const onStart = (event: TouchEvent) => {
            if (event.touches.length !== 1 || machine.phase === "driven" || leaving || watching) {
                machine.cancel();
                return;
            }
            const touch = event.touches[0]!;
            const element = event.target instanceof Element ? event.target : null;
            const area = element ? swipeRoot(main, element) : null;
            const found = area && element ? backControl(area, element) : null;
            const sign = direction();
            if (!found || !element || ownedElsewhere(element, found.pane, touch.clientX, sign)) {
                machine.cancel();
                return;
            }
            target = found;
            finger = touch.identifier;
            machine.start(sample(touch, event), sign);
        };
        const onMove = (event: TouchEvent) => {
            if (machine.phase !== "pending" && machine.phase !== "swiping") return;
            const touch = tracked(event.touches);
            if (!touch || event.touches.length !== 1) {
                machine.cancel();
                return;
            }
            if (machine.move(sample(touch, event), event.cancelable, event.defaultPrevented) && event.cancelable) {
                event.preventDefault();
            }
        };
        const onEnd = (event: TouchEvent) => {
            if (machine.phase === "idle" || machine.phase === "driven") return;
            if (event.touches.length > 0) {
                machine.cancel();
                return;
            }
            if (machine.end() && event.cancelable) event.preventDefault();
        };
        const onCancel = () => machine.cancel();
        const onHidden = () => machine.cancel();

        document.addEventListener("touchstart", onStart, { passive: true });
        document.addEventListener("touchmove", onMove, { passive: false });
        document.addEventListener("touchend", onEnd, { passive: false });
        document.addEventListener("touchcancel", onCancel);
        window.addEventListener("blur", onHidden);
        document.addEventListener("visibilitychange", onHidden);

        /** The open dialog or menu the app's back closes first, if any. */
        const openLayer = () => document.querySelector(OPEN_LAYER);
        /** What the app's back would press: the back of the dialog on top or of the screen. */
        const appBack = () => {
            const area = swipeRoot(main, null);
            return area ? backControl(area, null) : null;
        };
        const driver: SwipeBackDriver = {
            begin() {
                if (leaving || watching) return false;
                const found = appBack();
                if (!found) return false;
                target = found;
                machine.begin();
                return true;
            },
            progress(fraction) {
                machine.progress(Number(fraction) || 0);
            },
            cancel() {
                machine.abandon();
            },
            commit() {
                if (leaving || watching) return true;
                const found = machine.phase === "driven" && target ? target : appBack();
                if (found) {
                    target = found;
                    machine.commit();
                    return true;
                }
                machine.abandon();
                // Anything else open over the page - a dialog with no back of
                // its own, a sheet, a menu - closes the way Escape closes it.
                if (openLayer()) {
                    const focused = document.activeElement ?? document.body;
                    focused.dispatchEvent(
                        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
                    );
                    return true;
                }
                return false;
            }
        };
        window.polarisSwipeBack = driver;

        // Tell the phone app whether this screen has a back of its own, each
        // time that may have changed: a screen rendered, the window resized
        // across a breakpoint, a dialog opened or closed.
        let reported: boolean | null = null;
        let pending = 0;
        const report = () => {
            pending = 0;
            const available = Boolean(openLayer() || backControl(main, null));
            if (available === reported) return;
            reported = available;
            try {
                mobileBridge()?.swipeBack?.(available);
            } catch {
                // An app that cannot take the call keeps its own back.
            }
        };
        const schedule = () => {
            if (!pending) pending = window.setTimeout(report, 120);
        };
        const observer = new MutationObserver(schedule);
        observer.observe(main, { childList: true, subtree: true });
        observer.observe(document.body, { childList: true, attributes: true, subtree: false });
        window.addEventListener("resize", schedule);
        window.addEventListener("popstate", schedule);
        schedule();

        return () => {
            document.removeEventListener("touchstart", onStart);
            document.removeEventListener("touchmove", onMove);
            document.removeEventListener("touchend", onEnd);
            document.removeEventListener("touchcancel", onCancel);
            window.removeEventListener("blur", onHidden);
            document.removeEventListener("visibilitychange", onHidden);
            window.removeEventListener("resize", schedule);
            window.removeEventListener("popstate", schedule);
            observer.disconnect();
            window.clearTimeout(pending);
            window.clearTimeout(returning);
            window.clearTimeout(leaving);
            cancelAnimationFrame(watching);
            if (window.polarisSwipeBack === driver) delete window.polarisSwipeBack;
            machine.cancel();
            main.style.transform = "";
            main.style.transition = "";
            main.style.boxShadow = "";
            main.style.opacity = "";
            try {
                if (reported) mobileBridge()?.swipeBack?.(false);
            } catch {
                // As above.
            }
        };
    }, [root]);
}
