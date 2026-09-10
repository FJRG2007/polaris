"use client";

/**
 * The keyboard, for the people who never touch the mouse in a mail client.
 *
 * Which key does what is data now - `mail-keys` in @polaris/core - so a person
 * can move a shortcut from the settings screen and this hook simply reads the
 * map it is handed. The defaults are still the letters every mail client has
 * used since the first webmail that had any.
 *
 * Two rules make them safe to have on.
 *
 * **Nothing fires while somebody is typing.** A key pressed in an input, a
 * textarea, or anything a browser has marked editable belongs to that field -
 * `e` in a subject line must not archive the conversation behind the composer.
 * A modifier means the key belongs to the browser or the operating system, so
 * those are left alone too.
 *
 * **Nothing here is the only way to do anything.** Every one of these has a
 * button on screen. A shortcut that is the sole route to an action is one nobody
 * discovers and everybody else is locked out of.
 */

import * as core from "@polaris/core";
import { useEffect, useMemo, useRef } from "react";

/** What a screen can be asked to do from the keyboard. Anything a screen does
 *  not pass is simply not bound. */
export type MailKeyActions = {
    readonly [command in Exclude<core.MailKeyCommand, "back">]?: () => void;
} & {
    readonly back?: () => void;
    /** Pick every conversation on screen. The one binding here that takes a
     *  modifier, because it is the one everybody already presses - and so the
     *  one that is not on the settings screen. */
    readonly selectAll?: () => void;
    /** Let go of the selection. Tried before `back`, so Escape means "never
     *  mind" about the nearest thing first. */
    readonly clearSelection?: () => boolean;
};

/** Whether the key belongs to whatever has focus rather than to the screen. */
function typing(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Every default, held once so a screen that passes no keymap is not a new map
 *  on every render. */
const DEFAULT_KEYMAP: core.MailKeymap = {};

export function useMailKeys(
    actions: MailKeyActions,
    keymap: core.MailKeymap = DEFAULT_KEYMAP
): void {
    // Held in a ref so a screen can close over fresh state without the listener
    // being torn down and rebound on every render.
    const held = useRef(actions);
    held.current = actions;
    const resolved = useMemo(() => core.resolveMailKeymap(keymap), [keymap]);
    const keys = useRef(resolved);
    keys.current = resolved;

    useEffect(() => {
        function onKey(event: KeyboardEvent): void {
            if (event.defaultPrevented || typing(event.target)) return;

            const now = held.current;
            const run = (action: (() => void) | undefined): void => {
                if (!action) return;
                event.preventDefault();
                action();
            };

            // Select-all is the one thing here that is a modifier chord, because
            // it is the chord every list in every file manager has. Handled
            // before the bail below, which exists to leave the browser's own
            // chords alone.
            if (
                (event.metaKey || event.ctrlKey) &&
                !event.altKey &&
                event.key.toLowerCase() === "a"
            ) {
                return run(now.selectAll);
            }
            if (event.metaKey || event.ctrlKey || event.altKey) return;

            const command = keys.current.get(event.key);
            if (!command) return;
            if (command === "back") {
                // Escape undoes the nearest thing first: a selection if there is
                // one, and only then the conversation being read.
                if (now.clearSelection?.()) {
                    event.preventDefault();
                    return;
                }
                return run(now.back);
            }
            return run(now[command]);
        }

        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);
}

/**
 * What the help sheet lists, in the order it reads them, for the keyboard this
 * person actually has - a moved shortcut is shown where it now is. Built from
 * the same table the hook reads, so the two cannot drift.
 */
export function mailShortcuts(keymap: core.MailKeymap): readonly { keys: string; what: string }[] {
    const rows = core.MAIL_KEY_COMMANDS.map((command) => {
        const definition = core.MAIL_KEY_DEFINITIONS[command];
        const keys = [core.mailKeyFor(command, keymap), ...definition.fixed]
            .filter(Boolean)
            .map(core.mailKeyLabel)
            .join(" or ");
        return { keys, what: definition.label };
    });
    return [
        ...rows,
        { keys: "Mod+a", what: "Select everything shown" },
        { keys: "Shift+click", what: "Select a run of conversations" }
    ];
}
