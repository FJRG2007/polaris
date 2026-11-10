/**
 * What Polar just changed, told to the screen showing it.
 *
 * A tool runs on the server, so a screen that holds its own copy - the
 * automation editor's draft - would go on showing the old one. When a chat
 * part says a write tool finished, the panel announces it on the window, and
 * a screen that cares refetches. Only calls finished while the chat was on
 * screen are announced: a thread opened later does not replay its history.
 *
 * Client-safe.
 */

import { useEffect, useRef } from "react";

export const POLAR_CHANGED_EVENT = "polaris:polar-changed";

/** One finished write, as a screen reads it. */
export interface PolarChange {
    readonly tool: string;
    readonly automationId?: string;
    readonly href?: string;
}

/** The tools whose finished calls are announced. */
const ANNOUNCED = /^automations_(create|update|publish|set_enabled|run)$/;

interface PartLike {
    readonly type: string;
    readonly toolName?: string;
    readonly toolCallId?: string;
    readonly state?: string;
    readonly output?: unknown;
}

function toolName(part: PartLike): string | null {
    if (part.type === "dynamic-tool") return part.toolName ?? null;
    if (part.type.startsWith("tool-")) return part.type.slice(5);
    return null;
}

/** Every successful announced call in these messages, by call id. Pure, for the tests. */
export function finishedWrites(
    messages: readonly { readonly parts: readonly PartLike[] }[]
): Map<string, PolarChange> {
    const found = new Map<string, PolarChange>();
    for (const message of messages)
        for (const part of message.parts) {
            const name = toolName(part);
            if (!name || !ANNOUNCED.test(name) || part.state !== "output-available") continue;
            const output = part.output as
                | { ok?: unknown; data?: { automationId?: unknown; href?: unknown } | null }
                | undefined;
            if (!output || output.ok !== true || !part.toolCallId) continue;
            const data = output.data ?? {};
            found.set(part.toolCallId, {
                tool: name,
                ...(typeof data.automationId === "string"
                    ? { automationId: data.automationId }
                    : {}),
                ...(typeof data.href === "string" ? { href: data.href } : {})
            });
        }
    return found;
}

/** For the chat: announces each write that finishes while `thread` is on screen. */
export function useAnnounceWrites(
    thread: string,
    messages: readonly { readonly parts: readonly PartLike[] }[]
): void {
    const seen = useRef<{ thread: string; ids: Set<string> } | null>(null);
    useEffect(() => {
        const writes = finishedWrites(messages);
        if (!seen.current || seen.current.thread !== thread) {
            seen.current = { thread, ids: new Set(writes.keys()) };
            return;
        }
        for (const [id, change] of writes) {
            if (seen.current.ids.has(id)) continue;
            seen.current.ids.add(id);
            window.dispatchEvent(new CustomEvent(POLAR_CHANGED_EVENT, { detail: change }));
        }
    }, [thread, messages]);
}

/** For a screen: runs `onChange` for every write Polar finishes. */
export function usePolarChanges(onChange: (change: PolarChange) => void): void {
    const latest = useRef(onChange);
    latest.current = onChange;
    useEffect(() => {
        const listen = (event: Event) => latest.current((event as CustomEvent<PolarChange>).detail);
        window.addEventListener(POLAR_CHANGED_EVENT, listen);
        return () => window.removeEventListener(POLAR_CHANGED_EVENT, listen);
    }, []);
}

/**
 * Opens the next automation Polar creates, for a while after somebody asked it
 * to build one. Not tied to a component: the dialog that asked has closed.
 */
export function openNextCreated(open: (href: string) => void, withinMs = 10 * 60_000): void {
    const until = Date.now() + withinMs;
    const listen = (event: Event) => {
        const change = (event as CustomEvent<PolarChange>).detail;
        if (Date.now() > until) return window.removeEventListener(POLAR_CHANGED_EVENT, listen);
        if (change.tool !== "automations_create" || !change.href) return;
        window.removeEventListener(POLAR_CHANGED_EVENT, listen);
        open(change.href);
    };
    window.addEventListener(POLAR_CHANGED_EVENT, listen);
}
