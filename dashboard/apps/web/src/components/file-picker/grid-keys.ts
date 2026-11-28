/**
 * Arrow keys across a grid of tiles, shared by every grid the picker draws.
 */

/** Columns in a grid, counted from where its tiles wrap. */
export function columnsOf(list: HTMLElement | null): number {
    const tiles = list ? [...list.children] : [];
    const top = (tiles[0] as HTMLElement | undefined)?.offsetTop;
    const first = tiles.findIndex((one) => (one as HTMLElement).offsetTop !== top);
    return Math.max(1, first < 0 ? tiles.length : first);
}

/**
 * Move focus to the next `selector` in `list` for an arrow key: one at a time
 * in a list, by row and column in a grid. Enter and Space press the focused one
 * as usual. True when the key was used.
 */
export function moveFocus(
    event: { key: string; preventDefault(): void },
    list: HTMLElement | null,
    selector: string,
    grid: boolean
): boolean {
    const across = columnsOf(list);
    const steps: Record<string, number> = grid
        ? { ArrowRight: 1, ArrowLeft: -1, ArrowDown: across, ArrowUp: -across }
        : { ArrowDown: 1, ArrowUp: -1 };
    const step = steps[event.key];
    if (!step) return false;
    const buttons = [...(list?.querySelectorAll<HTMLElement>(selector) ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    const next = buttons[at < 0 ? 0 : Math.min(buttons.length - 1, Math.max(0, at + step))];
    if (!next) return false;
    event.preventDefault();
    next.focus();
    return true;
}
