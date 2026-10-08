"use client";

/**
 * The two keys every voice application has: F9 mutes, F10 deafens - by
 * default; they are the shared table's `chat.toggleMic` and `chat.toggleDeafen`,
 * so somebody can move them in Keyboard shortcuts.
 *
 * Bound by whatever holds the call, not by the screen that draws it. They used
 * to be bound by the room, so they worked while the room was on screen and did
 * nothing anywhere else - while the bar that follows the call across Polaris
 * said "Deafen (F10)" on its button. Pressing it from another page did nothing,
 * which is what "deafen only works sometimes" was.
 *
 * Exactly one binding per call, which is why it lives there and nowhere else:
 * two listeners for the same key would each toggle, and a press would undo
 * itself.
 *
 * Taken from the browser rather than left to it - F10 opens a menu bar in some
 * of them, and a shortcut that sometimes opens a menu instead of muting you is
 * worse than no shortcut. Function keys type nothing, so this is safe over a
 * composer somebody is writing in.
 */

import * as core from "@polaris/core";
import { shortcutBindings } from "@polaris/ui";
import { useEffect, useRef } from "react";

/** Which control a key press is for, or null for any other key - against the
 *  keys in force, or the defaults when none are given. Pure, so the rule can
 *  be asserted without a keyboard. A held key repeating is not another press. */
export function callHotkey(
    event: {
        readonly key: string;
        readonly code?: string;
        readonly ctrlKey: boolean;
        readonly metaKey: boolean;
        readonly altKey: boolean;
        readonly shiftKey?: boolean;
        readonly repeat: boolean;
    },
    bindings: ReadonlyMap<string, readonly string[]> = core.resolveShortcuts()
): "mic" | "deafen" | null {
    if (event.repeat) return null;
    // Read field by field: a DOM event's keys are getters, which a spread drops.
    const press = {
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey ?? false
    };
    const id = core.shortcutMatching(bindings, press, ["chat.toggleMic", "chat.toggleDeafen"]);
    if (id === "chat.toggleMic") return "mic";
    if (id === "chat.toggleDeafen") return "deafen";
    return null;
}

export function useCallHotkeys(
    call: { readonly toggleMic: () => void; readonly toggleDeafen: () => void },
    active: boolean
): void {
    // The latest controls, so the listener is added once per call rather than
    // on every render of the provider.
    const controls = useRef(call);
    controls.current = call;

    useEffect(() => {
        if (!active) return;
        const onKey = (event: KeyboardEvent) => {
            const which = callHotkey(event, shortcutBindings());
            if (!which) return;
            event.preventDefault();
            if (which === "mic") controls.current.toggleMic();
            else controls.current.toggleDeafen();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [active]);
}
