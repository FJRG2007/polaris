/**
 * Reading a key press as a binding (`Mod+Shift+k`), with no dependencies, so a
 * content script can match a press without carrying the whole shortcut table.
 * `shortcuts.ts` re-exports all of it; the binding grammar is documented there.
 */

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

const MODIFIERS = ["Mod", "Alt", "Shift"] as const;

/** The browser's names for keys that are not one character, as they are kept. */
const NAMED_KEYS = new Set([
    "Enter",
    "Escape",
    "Delete",
    "Backspace",
    "Tab",
    "Space",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Insert",
    "ContextMenu",
    ...Array.from({ length: 12 }, (_, at) => `F${at + 1}`)
]);

/** Other spellings browsers have used for the same keys. */
const ALIASES: Readonly<Record<string, string>> = {
    " ": "Space",
    Spacebar: "Space",
    Esc: "Escape",
    Del: "Delete",
    Up: "ArrowUp",
    Down: "ArrowDown",
    Left: "ArrowLeft",
    Right: "ArrowRight",
    Apps: "ContextMenu"
};

/** Keys that only modify another, never a shortcut of their own. */
const MODIFIER_KEYS = new Set([
    "Shift",
    "Control",
    "Alt",
    "AltGraph",
    "Meta",
    "OS",
    "CapsLock",
    "Fn",
    "FnLock",
    "Hyper",
    "Super",
    "Process",
    "Dead",
    "Unidentified"
]);

/**
 * Presses that are never offered as a binding: the ones the browser keeps for
 * itself and never hands a page (close the tab, open a window, quit), and Tab,
 * which is how somebody without a mouse gets from one control to the next.
 */
const RESERVED = new Set([
    "Tab",
    "Shift+Tab",
    "Mod+w",
    "Mod+Shift+w",
    "Mod+t",
    "Mod+Shift+t",
    "Mod+n",
    "Mod+Shift+n",
    "Mod+q",
    "Mod+Tab",
    "Mod+Shift+Tab",
    "Mod+l"
]);

/** The named keys by their lowercase spelling, so `enter` reads as `Enter`. */
const NAMED_BY_LOWER = new Map([...NAMED_KEYS].map((key) => [key.toLowerCase(), key]));

/** A key, in the form a binding keeps it, or null when it is not one. */
function canonicalKey(raw: string): string | null {
    // Some browsers send a keydown with no key at all (an autofill, an IME).
    if (typeof raw !== "string" || raw === "") return null;
    const named = Object.hasOwn(ALIASES, raw) ? (ALIASES[raw] as string) : raw;
    if (NAMED_KEYS.has(named)) return named;
    if ([...named].length > 1) {
        const found = NAMED_BY_LOWER.get(named.toLowerCase());
        if (found) return found;
    }
    const lowered = named.toLowerCase();
    // F-keys written in lowercase.
    if (/^f([1-9]|1[0-2])$/.test(lowered)) return lowered.toUpperCase();
    const chars = [...named];
    if (chars.length !== 1 || /\s/.test(named)) return null;
    return /\p{L}/u.test(named) ? lowered : named;
}

/** Whether a key is a letter, the one kind where Shift is part of the press. */
function isLetter(key: string): boolean {
    return [...key].length === 1 && /\p{L}/u.test(key);
}

/**
 * A binding in its one written form, or null when it is not a binding.
 *
 * `Ctrl`, `Cmd`, `Meta` and `Control` all mean `Mod`; `Option` means `Alt`. The
 * order is fixed, so `Shift+Mod+K` and `Mod+Shift+k` are the same string. Shift
 * on a symbol is dropped - `Shift+?` is `?` - since the symbol already says it.
 */
export function normalizeBinding(raw: string): string | null {
    const text = raw.trim();
    if (!text) return null;
    // The last token is the key, which is what lets `Mod++` and `Mod+-` parse.
    // The key itself may be "+": alone, or after a modifier (`Mod++`).
    const plus = text === "+" || text.endsWith("++");
    const tokens = plus
        ? [...(text === "+" ? [] : text.slice(0, -2).split("+")), "+"]
        : text.split("+");
    const keyToken = tokens.pop();
    if (keyToken === undefined || keyToken === "") return null;
    const held = new Set<string>();
    for (const token of tokens) {
        const word = token.trim().toLowerCase();
        if (["mod", "ctrl", "control", "cmd", "command", "meta"].includes(word)) held.add("Mod");
        else if (["alt", "option"].includes(word)) held.add("Alt");
        else if (word === "shift") held.add("Shift");
        else return null;
    }
    const key = canonicalKey(keyToken.trim() || keyToken);
    if (!key) return null;
    if (held.has("Shift") && [...key].length === 1 && !isLetter(key)) held.delete("Shift");
    return [...MODIFIERS.filter((modifier) => held.has(modifier)), key].join("+");
}

/** What a key press reads as, in the form a binding is written, or null for a
 *  press that is only a modifier going down. */
export function bindingOfEvent(event: {
    readonly key: string;
    readonly code?: string;
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
    readonly altKey: boolean;
    readonly shiftKey: boolean;
}): string | null {
    // With Alt held a Mac types a different character (Alt+D is "∂"), or starts
    // one (Alt+N is a dead key for "˜"), so the physical key is what was meant
    // for letters and digits.
    const physical = event.altKey && event.code !== undefined && /^(Key[A-Z]|Digit[0-9])$/.test(event.code);
    if (MODIFIER_KEYS.has(event.key) && !(event.key === "Dead" && physical)) return null;
    let key = event.key;
    if (event.altKey && event.code) {
        const letter = /^Key([A-Z])$/.exec(event.code)?.[1];
        const digit = /^Digit([0-9])$/.exec(event.code)?.[1];
        if (letter) key = letter.toLowerCase();
        else if (digit) key = digit;
        // Option+Space on a Mac types a non-breaking space, not " ".
        else if (event.code === "Space") key = "Space";
    }
    const canonical = canonicalKey(key);
    if (!canonical) return null;
    const parts: string[] = [];
    if (event.ctrlKey || event.metaKey) parts.push("Mod");
    if (event.altKey) parts.push("Alt");
    // Shift is part of a letter, a named key or a digit; a symbol was typed with it.
    if (
        event.shiftKey &&
        ([...canonical].length > 1 || isLetter(canonical) || /^[0-9]$/.test(canonical))
    )
        parts.push("Shift");
    return [...parts, canonical].join("+");
}

/** Whether a binding is one somebody may choose: valid, and not one the browser
 *  or keyboard navigation keeps. */
export function isBindable(binding: string): boolean {
    const normalized = normalizeBinding(binding);
    return normalized !== null && !RESERVED.has(normalized);
}

/** The pieces of a binding, for drawing one key cap each: the modifiers, then
 *  the key. */
export function bindingParts(binding: string): string[] {
    const normalized = normalizeBinding(binding) ?? binding;
    if (normalized === "+") return ["+"];
    if (normalized.endsWith("++")) return [...normalized.slice(0, -2).split("+"), "+"];
    return normalized.split("+");
}
