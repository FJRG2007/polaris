/**
 * Whether a tour step's target can be pointed at: on the page, drawn with a size,
 * not hidden and not disabled. Browser-only.
 */

import { tourSelector } from "./registry";

/** The asked-for event that opens the list of tours, from anywhere. */
export const OPEN_TOURS_EVENT = "polaris:open-tours";

export function openTourList(): void {
    window.dispatchEvent(new Event(OPEN_TOURS_EVENT));
}

/** The first usable element carrying the target, or null. Several elements can
 *  share one (the empty state and the list of the same screen). */
export function usableTarget(target: string, root: ParentNode = document): HTMLElement | null {
    for (const element of root.querySelectorAll<HTMLElement>(tourSelector(target))) {
        if (isUsable(element)) return element;
    }
    return null;
}

export function isUsable(element: HTMLElement): boolean {
    if (element.closest("[inert],[aria-hidden='true']")) return false;
    if (element.matches(":disabled,[aria-disabled='true']")) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
}
