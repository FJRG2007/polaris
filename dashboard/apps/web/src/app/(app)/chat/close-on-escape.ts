"use client";

/**
 * Escape closes the conversation, the way it does in WhatsApp: back to the empty
 * screen, with nothing left, deleted or lost - a draft stays in its box.
 *
 * Escape means a great many things before it means that. A dialog, a menu, the
 * emoji picker, the @ list and an edit in progress all close on it, and each of
 * them says so by taking the key (`preventDefault`) - so a key somebody else
 * already handled is not this one's. An open dialog or menu that did not take it
 * is also left alone: closing the conversation behind it is never what the press
 * was for.
 */

import { useEffect, useRef } from "react";

/** What still owns the key while it is on screen. `data-state` rather than the
 *  role alone, because a menu's submenus stay mounted and hidden once opened. */
const OVERLAY = [
    "[role='dialog'][data-state='open']",
    "[role='alertdialog'][data-state='open']",
    "[role='menu'][data-state='open']",
    "[role='listbox'][data-state='open']"
].join(", ");

export function closesConversation(event: KeyboardEvent, root: ParentNode = document): boolean {
    if (event.key !== "Escape" || event.defaultPrevented || event.repeat || event.isComposing) return false;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
    return root.querySelector(OVERLAY) === null;
}

/**
 * Call `onEscape` for a press nothing else wanted.
 *
 * On the window and in the bubbling phase, so everything nearer the focus -
 * and the document-level listeners the pickers and the composer use - has had
 * its turn first.
 */
export function useCloseOnEscape(onEscape: () => void): void {
    const latest = useRef(onEscape);
    latest.current = onEscape;

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (!closesConversation(event)) return;
            event.preventDefault();
            latest.current();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);
}
