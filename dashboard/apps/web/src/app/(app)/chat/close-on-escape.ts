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
 * was for. A popup that is neither must take the key itself when it closes on
 * Escape, or this closes the conversation on the same press.
 */

import { useEffect, useRef } from "react";

/** What still owns the key while it is on screen. `data-state` rather than the
 *  role alone, because a menu's submenus stay mounted and hidden once opened.
 *  A modal is only mounted while it is open, so one without a state counts. */
const OVERLAY = [
    "[aria-modal='true']:not([data-state='closed'])",
    "[role='dialog'][data-state='open']",
    "[role='alertdialog'][data-state='open']",
    "[role='menu'][data-state='open']",
    "[role='listbox'][data-state='open']"
].join(", ");

export function closesConversation(event: KeyboardEvent, root: ParentNode = document): boolean {
    if (event.key !== "Escape" || event.defaultPrevented || event.repeat || event.isComposing)
        return false;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
    return root.querySelector(OVERLAY) === null;
}

/**
 * Call `onEscape` for a press nothing else wanted, wherever the focus is.
 *
 * Seen on the way in, at the window in the capture phase, so no handler nearer
 * the focus can hide it: one that stops propagation on Escape (a row, a field,
 * a panel) used to swallow the press before it bubbled back up here, which is
 * why closing seemed to depend on where the last click landed. Whether an
 * overlay owns the key is read then, before it closes itself; whether anybody
 * took the key is read once the press has been handled everywhere, in the task
 * after it, so the pickers, the composer and the dialogs still come first.
 */
export function useCloseOnEscape(onEscape: () => void): void {
    const latest = useRef(onEscape);
    latest.current = onEscape;

    useEffect(() => {
        const pending = new Set<ReturnType<typeof setTimeout>>();
        const onKey = (event: KeyboardEvent) => {
            if (!closesConversation(event)) return;
            const timer = setTimeout(() => {
                pending.delete(timer);
                if (!event.defaultPrevented) latest.current();
            }, 0);
            pending.add(timer);
        };
        window.addEventListener("keydown", onKey, true);
        return () => {
            window.removeEventListener("keydown", onKey, true);
            for (const timer of pending) clearTimeout(timer);
        };
    }, []);
}
