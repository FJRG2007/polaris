/**
 * The launcher's key: recorded in the settings in the dashboard's spelling
 * (`Alt+Space`, `Mod+Shift+K`), held through Electron's `globalShortcut` as an
 * accelerator (`toAccelerator`, shared with the call keys so both refuse the
 * same presses), and shown back as a person reads it.
 *
 * Alt+Space by default, as Raycast for Windows and PowerToys Run use - the
 * press people already reach for. On Windows it is otherwise the focused
 * window's system menu; a program that registers it system-wide takes it from
 * that menu, so whoever registered first owns it and `register` answers false
 * for everybody after (https://www.electronjs.org/docs/latest/api/global-shortcut,
 * https://manual.raycast.com/windows, https://learn.microsoft.com/windows/powertoys/run).
 */

import { toAccelerator } from "./call-hotkeys";

/** The key the launcher opens with until somebody records another. */
export const DEFAULT_LAUNCHER_BINDING = "Alt+Space";

/** What a keydown carries that a binding is made of. */
export interface KeyPress {
    readonly code: string;
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
    readonly altKey: boolean;
    readonly shiftKey: boolean;
}

const CODES: Readonly<Record<string, string>> = {
    Space: "Space",
    Enter: "Enter",
    Backspace: "Backspace",
    Delete: "Delete",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    ArrowUp: "ArrowUp",
    ArrowDown: "ArrowDown",
    ArrowLeft: "ArrowLeft",
    ArrowRight: "ArrowRight",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backquote: "`",
    Backslash: "\\"
};

/** The key of a press by its place on the keyboard, so the same key records
 *  the same binding on any layout; null for a modifier or a key not offered. */
function keyOf(code: string): string | null {
    const letter = /^Key([A-Z])$/.exec(code);
    if (letter) return letter[1]!;
    const digit = /^Digit([0-9])$/.exec(code);
    if (digit) return digit[1]!;
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
    return CODES[code] ?? null;
}

/**
 * A recorded press as a binding, or null when it is only modifiers, a key not
 * offered, or a press nobody may take from every other program (a bare letter).
 * Mod is Cmd on macOS and Ctrl elsewhere; Ctrl on macOS is not offered.
 */
export function bindingFromPress(press: KeyPress, platform: NodeJS.Platform): string | null {
    const key = keyOf(press.code);
    if (!key) return null;
    const mod = platform === "darwin" ? press.metaKey : press.ctrlKey;
    if (platform === "darwin" && press.ctrlKey) return null;
    if (platform !== "darwin" && press.metaKey) return null;
    const binding = [mod ? "Mod" : null, press.altKey ? "Alt" : null, press.shiftKey ? "Shift" : null, key]
        .filter((part): part is string => part !== null)
        .join("+");
    return toAccelerator(binding) ? binding : null;
}

/** A binding the launcher may hold as its accelerator, or null. */
export function launcherAccelerator(binding: string): string | null {
    return toAccelerator(binding);
}

/** An accelerator the way the platform names its keys: `Alt+Space` on Windows,
 *  `Option+Space` and `Cmd+K` on macOS. */
export function displayAccelerator(accelerator: string, platform: NodeJS.Platform): string {
    const mac = platform === "darwin";
    return accelerator
        .split("+")
        .map((part, index, parts) => {
            if (part === "" && index === parts.length - 1) return "+";
            if (part === "CommandOrControl") return mac ? "Cmd" : "Ctrl";
            if (part === "Alt") return mac ? "Option" : "Alt";
            if (part === "Plus") return "+";
            return part;
        })
        .join("+");
}
