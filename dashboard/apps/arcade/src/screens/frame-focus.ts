const KEPT_FIELDS = "input, textarea, select, [contenteditable=''], [contenteditable='true']";
const KEPT_LAYERS = "[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']";

/**
 * Whether the frame may take the keyboard: when nothing has it, or anything but
 * a field or an open dialog, menu or list does. A button keeps the focus after it is pressed
 * - the Join that started the game, the one a closed dialog gives it back to -
 * and that is not the reader doing something there; a call's chat is.
 */
export function mayTakeFocus(active: Element | null): boolean {
    if (
        !active ||
        active === active.ownerDocument.body ||
        active === active.ownerDocument.documentElement ||
        active.tagName === "IFRAME"
    )
        return true;
    return !active.matches(KEPT_FIELDS) && !active.closest(KEPT_LAYERS);
}

const DRIVING_KEYS = new Set([
    "KeyW",
    "KeyA",
    "KeyS",
    "KeyD",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight"
]);

/** A key the reader means for the game, pressed while the page still has the
 *  keyboard. Whatever the page acted on itself stays the page's. */
export function isDrivingKey(
    event: Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "altKey" | "defaultPrevented">
): boolean {
    return (
        DRIVING_KEYS.has(event.code) &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.defaultPrevented
    );
}
