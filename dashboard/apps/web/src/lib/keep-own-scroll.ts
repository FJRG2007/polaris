/**
 * Letting something drawn on the body scroll while a modal dialog is open.
 *
 * A modal dialog locks scrolling for everything outside itself by cancelling
 * every wheel and touch move that reaches the document. A list or panel drawn on
 * the body - to escape the dialog's clipping - is outside it, so over a list
 * longer than its box the mouse wheel did nothing: the "/" menu in a task
 * comment, the people list of the share dialog, the emoji panel in a dialog's
 * composer. Stopping those events at the element keeps them from the lock and
 * lets it scroll as it does anywhere else; the page behind still does not move,
 * since these lists contain their own overscroll.
 *
 * Usable as a ref callback. The listeners go with the element.
 */

const kept = new WeakSet<HTMLElement>();

function stop(event: Event): void {
    event.stopPropagation();
}

export function keepOwnScroll(element: HTMLElement | null): void {
    if (!element || kept.has(element)) return;
    kept.add(element);
    element.addEventListener("wheel", stop, { passive: true });
    element.addEventListener("touchmove", stop, { passive: true });
}
