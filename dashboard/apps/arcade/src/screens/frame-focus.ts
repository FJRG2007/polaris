/**
 * Whether the frame may take the keyboard once the game is up: when nothing has
 * it, or the frame or this screen's own controls do - never from a field or a
 * control elsewhere on the page, such as a call's chat.
 */
export function mayTakeFocus(active: Element | null, screen: Element | null): boolean {
    if (!active || active === active.ownerDocument.body || active === active.ownerDocument.documentElement)
        return true;
    if (active.tagName === "IFRAME") return true;
    const typing = active.matches("input, textarea, select, [contenteditable=''], [contenteditable='true']");
    return !typing && !!screen?.contains(active);
}
