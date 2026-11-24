/**
 * The call's keys - mute and deafen - held by the operating system while a
 * call is on, so they work with another program in front, as they do in every
 * voice app.
 *
 * The dashboard sends its bindings in its own spelling (`F9`, `Mod+Shift+m`);
 * this turns each into an Electron accelerator, or refuses it. A key held
 * system-wide is taken from every other program, so only a press nobody types
 * is accepted: a function key, alone or with modifiers, or any key with Ctrl,
 * Cmd or Alt held. A bare letter would stop the computer typing that letter.
 */

import { z } from "zod";

/** The two controls a call key can be for. */
export type CallHotkey = "mic" | "deafen";

/** The most keys one control may hold, as the dashboard caps them. */
const MAX_KEYS = 4;

export const callHotkeysSchema = z
    .object({
        mic: z.array(z.string().max(40)).max(MAX_KEYS),
        deafen: z.array(z.string().max(40)).max(MAX_KEYS)
    })
    .strict()
    .nullable();

export type CallHotkeysInput = z.infer<typeof callHotkeysSchema>;

/** Which controls the system took, each false when none of its keys could be. */
export interface CallHotkeysResult {
    readonly mic: boolean;
    readonly deafen: boolean;
}

const NAMED: Readonly<Record<string, string>> = {
    Enter: "Enter",
    Escape: "Esc",
    Delete: "Delete",
    Backspace: "Backspace",
    Space: "Space",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Insert: "Insert"
};

/** A dashboard binding as an accelerator, or null when it cannot be one or is
 *  not safe to take from every other program. */
export function toAccelerator(binding: string): string | null {
    const text = binding.trim();
    if (!text) return null;
    const plus = text === "+" || text.endsWith("++");
    const tokens = plus ? [...(text === "+" ? [] : text.slice(0, -2).split("+")), "+"] : text.split("+");
    const keyToken = tokens.pop();
    if (!keyToken) return null;
    const held = new Set<string>();
    for (const token of tokens) {
        const word = token.trim().toLowerCase();
        if (word === "mod") held.add("CommandOrControl");
        else if (word === "alt") held.add("Alt");
        else if (word === "shift") held.add("Shift");
        else return null;
    }
    let key: string;
    const fn = /^F([1-9]|1[0-9]|2[0-4])$/.exec(keyToken);
    if (fn) key = `F${fn[1]}`;
    else if (keyToken in NAMED) key = NAMED[keyToken]!;
    else if (keyToken === "+") key = "Plus";
    else if (/^[a-z0-9]$/i.test(keyToken)) key = keyToken.toUpperCase();
    else if ([...keyToken].length === 1 && /^[-=[\];',./`\\]$/.test(keyToken)) key = keyToken;
    else return null;
    // Nothing anybody types: a function key, or a key with Ctrl, Cmd or Alt.
    if (!fn && !held.has("CommandOrControl") && !held.has("Alt")) return null;
    return [...["CommandOrControl", "Alt", "Shift"].filter((modifier) => held.has(modifier)), key].join("+");
}

/** Each control's accelerators, without repeats and without one two controls
 *  would both answer to. */
export function callAccelerators(input: NonNullable<CallHotkeysInput>): Map<string, CallHotkey> {
    const out = new Map<string, CallHotkey>();
    const owner = new Map<string, CallHotkey>();
    for (const which of ["mic", "deafen"] as const) {
        for (const binding of input[which]) {
            const accelerator = toAccelerator(binding);
            if (!accelerator) continue;
            const held = owner.get(accelerator);
            if (held === which) continue;
            if (held) {
                out.delete(accelerator);
                continue;
            }
            owner.set(accelerator, which);
            out.set(accelerator, which);
        }
    }
    return out;
}
