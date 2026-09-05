/**
 * Printing a keyboard shortcut the way the machine reading it would type it.
 *
 * A menu row and its key binding are written in two different places, and a hint
 * hard-coded as "Ctrl+C" is wrong on every Mac in the building - which is worse
 * than no hint at all, because somebody will try it. So a shortcut is written
 * once, platform-neutral, and printed for whoever is looking: `Mod+C` is the
 * key that means "the one next to the space bar", and it comes out as `Ctrl+C`
 * on a PC and as an apple `⌘C`.
 *
 * Nothing here binds anything. It prints, and the screen that prints a shortcut
 * is the screen that has to bind it - a hint for a key that does nothing is the
 * same defect as no hint, pointing the other way.
 */

/** How each modifier prints. Apple stacks glyphs with no separator, which is why
 *  the join differs as well as the words. */
const APPLE_KEYS: Record<string, string> = {
    mod: "⌘",
    meta: "⌘",
    cmd: "⌘",
    ctrl: "⌃",
    control: "⌃",
    alt: "⌥",
    option: "⌥",
    shift: "⇧"
};

const PC_KEYS: Record<string, string> = {
    mod: "Ctrl",
    meta: "Win",
    cmd: "Ctrl",
    ctrl: "Ctrl",
    control: "Ctrl",
    alt: "Alt",
    option: "Alt",
    shift: "Shift"
};

/** Keys whose full name is longer than the column deserves, or that have a glyph
 *  everybody reads faster than the word. */
const APPLE_NAMES: Record<string, string> = {
    delete: "⌫",
    backspace: "⌫",
    enter: "↩",
    return: "↩",
    escape: "⎋",
    esc: "⎋",
    tab: "⇥",
    space: "Space",
    arrowup: "↑",
    arrowdown: "↓",
    arrowleft: "←",
    arrowright: "→"
};

const PC_NAMES: Record<string, string> = {
    delete: "Del",
    backspace: "Backspace",
    enter: "Enter",
    return: "Enter",
    escape: "Esc",
    esc: "Esc",
    tab: "Tab",
    space: "Space",
    arrowup: "↑",
    arrowdown: "↓",
    arrowleft: "←",
    arrowright: "→"
};

/**
 * A shortcut written as `Mod+Shift+K`, printed for this platform.
 *
 * The last token is the key and everything before it is a modifier, which is
 * what lets `Mod++` and `Mod+-` work without a parser. A single character comes
 * out uppercase - `Mod+c` and `Mod+C` are the same press and should read the
 * same - and anything longer keeps the shape it was given, so `F2` stays `F2`.
 */
export function formatShortcut(spec: string, apple: boolean): string {
    const modifierNames = apple ? APPLE_KEYS : PC_KEYS;
    const keyNames = apple ? APPLE_NAMES : PC_NAMES;

    // Modifiers are taken off the front while they are recognised, and whatever
    // is left is the key - rejoined, so `Mod++` and `Mod+-` survive without the
    // separator eating the thing being pressed.
    const tokens = spec.split("+");
    const modifiers: string[] = [];
    let at = 0;
    while (at < tokens.length - 1 && (tokens[at] ?? "").trim().toLowerCase() in modifierNames) {
        modifiers.push(modifierNames[(tokens[at] ?? "").trim().toLowerCase()] ?? "");
        at += 1;
    }
    const key = tokens.slice(at).join("+").trim();
    const printedKey = keyNames[key.toLowerCase()] ?? (key.length === 1 ? key.toUpperCase() : key);

    return apple ? [...modifiers, printedKey].join("") : [...modifiers, printedKey].join("+");
}

/** Whether this is a machine whose modifier is the command key. Read from the
 *  platform rather than from the user agent's browser half, which says nothing
 *  about the keyboard. */
export function applePlatform(): boolean {
    if (typeof navigator === "undefined") return false;
    const platform =
        (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
        navigator.platform ??
        "";
    return /mac|iphone|ipad|ipod/i.test(platform);
}
