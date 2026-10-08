"use client";

/**
 * The keyboard, for the people who never touch the mouse in a mail client.
 *
 * Which key does what is data - the `mail.*` entries of the shortcuts table every
 * app shares - so a person can move a shortcut from the settings screen and this
 * hook simply asks which action a press is. The defaults are still the letters
 * every mail client has used since the first webmail that had any.
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
import { useShortcuts, type ShortcutHandler } from "@polaris/ui";

/** What a screen can be asked to do from the keyboard. Anything a screen does
 *  not pass is simply not bound. */
export type MailKeyActions = {
    readonly [command in Exclude<core.MailKeyCommand, "back">]?: () => void;
} & {
    readonly back?: () => void;
    /** Pick every conversation on screen. */
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

/**
 * Bind a screen's actions to the keys this person has for them - the shared
 * table's `mail.*` entries (see `shortcuts` in @polaris/core), which is also
 * where a key moved in Mail's settings before that table existed now lives.
 */
export function useMailKeys(actions: MailKeyActions): void {
    const run =
        (action: (() => void) | undefined): ShortcutHandler =>
        () => {
            if (!action) return false;
            action();
        };
    const handlers: Record<string, ShortcutHandler | undefined> = {
        "mail.selectAll": run(actions.selectAll),
        // Escape undoes the nearest thing first: a selection if there is one,
        // and only then the conversation being read.
        "mail.back": () => {
            if (actions.clearSelection?.()) return;
            if (!actions.back) return false;
            actions.back();
        }
    };
    for (const command of core.MAIL_KEY_COMMANDS) {
        if (command === "back") continue;
        handlers[`mail.${command}`] = run(actions[command]);
    }
    useShortcuts(handlers, { when: (event) => !typing(event.target) });
}
