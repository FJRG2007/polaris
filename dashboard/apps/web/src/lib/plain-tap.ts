import type { MouseEvent } from "react";

let lastClickWasTouch = false;

/** Whether a click came from a finger. A click is not a pointer event in every
 *  browser, so one without a pointer type falls back to the kind of screen. */
function touchClick(event: MouseEvent): boolean {
    const pointer = (event.nativeEvent as PointerEvent).pointerType;
    if (pointer !== undefined) return pointer === "touch";
    return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}

/** A plain tap of a finger, which on a phone opens what it lands on: nobody
 *  double-taps a file. A double click names no pointer, so it counts as whatever
 *  made the click before it: a screen can have both a finger and a mouse. */
export function plainTap(event: MouseEvent): boolean {
    if (event.type !== "dblclick") lastClickWasTouch = touchClick(event);
    return lastClickWasTouch && !event.shiftKey && !event.ctrlKey && !event.metaKey;
}
