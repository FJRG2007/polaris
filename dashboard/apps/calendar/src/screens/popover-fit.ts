/**
 * FullCalendar's "+N more" popover, kept on screen.
 *
 * FullCalendar (6.1.22, `Popover.updateSize`) puts the popover over the day it
 * belongs to and keeps it clear of the top and the sides of the window, never
 * the bottom: a day in the last row opened a list that ran past the bottom of
 * the screen, and whatever was down there could not be reached. The menus
 * answer this by moving up until they fit and scrolling inside when even that
 * is not enough; this does the same to the popover the moment it appears.
 *
 * It is placed once, when it opens, so it is moved once, then.
 */

/** Room kept between the popover and the edge, as FullCalendar keeps at the top. */
const EDGE = 10;

/** Move one popover up until its bottom is in view, and cap it to the room
 *  there is so its list scrolls instead of running off. */
export function fitPopover(popover: HTMLElement, bounds: { top: number; bottom: number }): void {
    const top = bounds.top + EDGE;
    const bottom = bounds.bottom - EDGE;
    const room = Math.max(0, bottom - top);
    popover.style.maxHeight = `${room}px`;
    const rect = popover.getBoundingClientRect();
    const over = rect.bottom - bottom;
    if (over <= 0) return;
    const shift = Math.min(over, Math.max(0, rect.top - top));
    const current = Number.parseFloat(popover.style.top || "0") || 0;
    popover.style.top = `${current - shift}px`;
}

/** Fit every popover that opens inside `root` for as long as it is watched.
 *  Returns the way to stop. */
export function keepPopoversInView(root: HTMLElement): () => void {
    const fit = (popover: HTMLElement) => {
        const area = root.getBoundingClientRect();
        fitPopover(popover, {
            top: Math.max(0, area.top),
            bottom: Math.min(window.innerHeight, area.bottom)
        });
    };
    const observer = new MutationObserver((changes) => {
        for (const change of changes)
            for (const node of change.addedNodes) {
                if (!(node instanceof HTMLElement)) continue;
                const popover = node.classList.contains("fc-popover")
                    ? node
                    : node.querySelector<HTMLElement>(".fc-popover");
                if (popover) fit(popover);
            }
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
}
