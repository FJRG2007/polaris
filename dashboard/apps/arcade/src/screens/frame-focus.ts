/**
 * Whether the frame may take the keyboard: when nothing has it, or anything but
 * a field or an open dialog does. A button keeps the focus after it is pressed
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
    return !active.matches(
        "input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='dialog'], [role='dialog'] *"
    );
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
