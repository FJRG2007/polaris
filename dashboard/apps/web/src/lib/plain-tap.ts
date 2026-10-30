import type { MouseEvent } from "react";

/** A plain tap of a finger, which on a phone opens what it lands on: nobody
 *  double-taps a file. A click is not a pointer event in every browser, and a
 *  double click is one in none, so those fall back to the kind of screen. */
export function plainTap(event: MouseEvent): boolean {
    if (event.shiftKey || event.ctrlKey || event.metaKey) return false;
    const pointer = (event.nativeEvent as PointerEvent).pointerType;
    if (pointer !== undefined) return pointer === "touch";
    return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}
