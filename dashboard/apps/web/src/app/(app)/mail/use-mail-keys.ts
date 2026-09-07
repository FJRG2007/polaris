"use client";

/**
 * The keyboard, for the people who never touch the mouse in a mail client.
 *
 * The letters are the ones every mail client has used since the first webmail
 * that had any, because somebody arriving from another client already has them
 * in their fingers and a client with its own scheme is a client they are slow in
 * for a month.
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

import { useEffect, useRef } from "react";

/** What a screen can be asked to do from the keyboard. Anything a screen does
 *  not pass is simply not bound. */
export interface MailKeyActions {
    readonly compose?: () => void;
    readonly reply?: () => void;
    readonly replyAll?: () => void;
    readonly forward?: () => void;
    readonly archive?: () => void;
    readonly trash?: () => void;
    readonly junk?: () => void;
    readonly star?: () => void;
    readonly markUnread?: () => void;
    readonly next?: () => void;
    readonly previous?: () => void;
    readonly open?: () => void;
    readonly back?: () => void;
    readonly search?: () => void;
    readonly refresh?: () => void;
    /** Pick every conversation on screen. The one binding here that takes a
     *  modifier, because it is the one everybody already presses. */
    readonly selectAll?: () => void;
    /** Let go of the selection. Tried before `back`, so Escape means "never
     *  mind" about the nearest thing first. */
    readonly clearSelection?: () => boolean;
}

/** Whether the key belongs to whatever has focus rather than to the screen. */
function typing(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function useMailKeys(actions: MailKeyActions): void {
    // Held in a ref so a screen can close over fresh state without the listener
    // being torn down and rebound on every render.
    const held = useRef(actions);
    held.current = actions;

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
            if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "a") {
                return run(now.selectAll);
            }
            if (event.metaKey || event.ctrlKey || event.altKey) return;

            switch (event.key) {
                case "c":
                    return run(now.compose);
                case "r":
                    return run(now.reply);
                case "a":
                    return run(now.replyAll);
                case "f":
                    return run(now.forward);
                case "e":
                    return run(now.archive);
                // Two spellings of the same thing. `#` is what a mail client
                // has always used; Delete is what somebody who has never used
                // one reaches for, and there is no reason it should not work.
                case "#":
                case "Delete":
                case "Backspace":
                    return run(now.trash);
                case "!":
                    return run(now.junk);
                case "s":
                    return run(now.star);
                case "u":
                    return run(now.markUnread);
                case "j":
                case "ArrowDown":
                    return run(now.next);
                case "k":
                case "ArrowUp":
                    return run(now.previous);
                case "Enter":
                    return run(now.open);
                case "Escape":
                    // Escape undoes the nearest thing first: a selection if
                    // there is one, and only then the conversation being read.
                    if (now.clearSelection?.()) {
                        event.preventDefault();
                        return;
                    }
                    return run(now.back);
                case "/":
                    return run(now.search);
                case "g":
                    return run(now.refresh);
                default:
                    return;
            }
        }

        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);
}

/** What the help sheet lists, in the order it reads them. Kept beside the
 *  bindings so the two cannot drift. */
export const MAIL_SHORTCUTS: readonly { keys: string; what: string }[] = [
    { keys: "c", what: "Write a message" },
    { keys: "j / k", what: "Next and previous conversation" },
    { keys: "Enter", what: "Open the one you are on" },
    { keys: "Esc", what: "Back to the list" },
    { keys: "r", what: "Reply" },
    { keys: "a", what: "Reply to everybody" },
    { keys: "f", what: "Forward" },
    { keys: "e", what: "Archive" },
    { keys: "Delete or #", what: "Move to the trash" },
    { keys: "Mod+a", what: "Select everything shown" },
    { keys: "Shift+click", what: "Select a run of conversations" },
    { keys: "!", what: "Report as spam" },
    { keys: "s", what: "Star or unstar" },
    { keys: "u", what: "Mark unread" },
    { keys: "/", what: "Search" },
    { keys: "g", what: "Check for new mail" },
    { keys: "?", what: "This list" }
];
