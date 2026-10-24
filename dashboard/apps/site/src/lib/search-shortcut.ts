/** The keys that open the docs search, apart from the panel so they can be asserted. */

/** Whether a key press is the shortcut that opens the panel. */
export function opensSearch(event: {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    target: EventTarget | null;
}): boolean {
    if (event.key.toLowerCase() === "k" && (event.ctrlKey || event.metaKey) && !event.altKey)
        return true;
    if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return false;
    const target = event.target as HTMLElement | null;
    // A slash typed into a field is a slash.
    return !(
        target &&
        (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)
    );
}
