"use client";

/**
 * Polar Code's keyboard: the `code.*` actions of the shared shortcut table
 * (`shortcuts` in @polaris/core), so they are moved from the same settings as
 * every other app's and listed in the same help sheet.
 *
 * - **Only while Code has the keyboard.** A press counts when focus is inside
 *   the Code view, or on the page itself on Polar's own page. A dialog, a menu
 *   or a picker open on top is outside the view, so its keys stay its own.
 * - **Typing wins.** In a text field only presses with Ctrl/Cmd or Alt, and
 *   Escape, are Code's; a plain letter or `?` is typed.
 * - **Escape stops a turn only when pressed twice** within two seconds, the
 *   way OpenCode asks before interrupting, so dismissing something by habit
 *   never ends the agent's work.
 */

import { useShortcuts, type ShortcutHandler } from "@polaris/ui";
import { useCallback, useRef, useState, type RefObject } from "react";

/** How long a first Escape waits for the second. */
export const STOP_AGAIN_MS = 2_000;

/** Whether a press lands in something that takes typed text. */
export function typingIn(target: EventTarget | null): boolean {
    if (!target || typeof (target as HTMLElement).tagName !== "string") return false;
    const element = target as HTMLElement;
    if (element.isContentEditable) return true;
    return ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName);
}

/** Whether a press belongs to Code at all: see the module comment. */
export function codeHasKeyboard(
    event: Pick<KeyboardEvent, "target" | "key" | "ctrlKey" | "metaKey" | "altKey">,
    root: HTMLElement | null,
    fullPage: boolean
): boolean {
    const target = event.target as Node | null;
    const inside = root !== null && target !== null && root.contains(target);
    const onPage = fullPage && typeof document !== "undefined" && target === document.body;
    if (!inside && !onPage) return false;
    if (!typingIn(event.target)) return true;
    return event.ctrlKey || event.metaKey || event.altKey || event.key === "Escape";
}

/** Listen for Code's actions while `root` is drawn. */
export function useCodeKeys(
    root: RefObject<HTMLElement | null>,
    fullPage: boolean,
    handlers: Readonly<Record<string, ShortcutHandler | undefined>>
): void {
    useShortcuts(handlers, {
        when: (event) => codeHasKeyboard(event, root.current, fullPage)
    });
}

/**
 * The two-press stop. `press` answers true when this press stops the turn,
 * false when it only armed it (and `armed` is then true until it lapses).
 */
export function useStopTwice(): { armed: boolean; press: () => boolean; disarm: () => void } {
    const [armed, setArmed] = useState(false);
    const at = useRef(0);
    const timer = useRef<number | null>(null);
    const disarm = useCallback(() => {
        at.current = 0;
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = null;
        setArmed(false);
    }, []);
    const press = useCallback(() => {
        const now = Date.now();
        if (at.current !== 0 && now - at.current <= STOP_AGAIN_MS) {
            disarm();
            return true;
        }
        at.current = now;
        setArmed(true);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(disarm, STOP_AGAIN_MS);
        return false;
    }, [disarm]);
    return { armed, press, disarm };
}

/** The session after or before `current` in the history's order, or null at an end. */
export function neighbourSession(
    ids: readonly string[],
    current: string | null,
    step: 1 | -1
): string | null {
    if (ids.length === 0) return null;
    if (current === null) return step === 1 ? (ids[0] ?? null) : null;
    const at = ids.indexOf(current);
    if (at === -1) return ids[0] ?? null;
    return ids[at + step] ?? null;
}
