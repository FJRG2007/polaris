/**
 * Stopping a menu from choosing an item on the release of the press that opened
 * it.
 *
 * Radix selects an item on pointer-up even when the press began somewhere else,
 * so that a menu can be worked by pressing the trigger and dragging onto an
 * option. A menu opens a few pixels under its trigger, which puts its first
 * option directly under the pointer: pressing the button and letting the hand
 * slide down before releasing commits that first option without anybody having
 * chosen it - and on a priority menu the first option is "Urgent".
 *
 * So a release only counts as a choice when the press that goes with it started
 * inside a menu. Pressing and releasing on the trigger opens the menu and does
 * nothing else; choosing an option is then a press of its own.
 */

import type { PointerEvent as ReactPointerEvent } from "react";

/** Whether the press currently in progress started inside a menu. */
let pressedInsideMenu = false;
let watching = false;

/** Radix marks every menu surface with this, dropdowns and context menus alike. */
const MENU_SURFACE = "[data-radix-menu-content], [data-radix-popper-content-wrapper]";

function watchPresses(): void {
    if (watching || typeof document === "undefined") return;
    watching = true;
    document.addEventListener(
        "pointerdown",
        (event) => {
            const target = event.target;
            pressedInsideMenu = target instanceof Element && target.closest(MENU_SURFACE) !== null;
        },
        true
    );
}

watchPresses();

/** Pass as a menu content's `onPointerUpCapture`. */
export function ignoreOpeningPress(event: ReactPointerEvent): void {
    if (pressedInsideMenu) return;
    event.stopPropagation();
}
