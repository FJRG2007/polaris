/**
 * The session's stored messages as Polar Code's thread shows them.
 *
 * Pure, so what a thread hides can be asserted: Polaris's own handoff notes
 * (`withoutHandoff`), and an answer stored twice in a row - the same reply
 * reaching the thread from the Chat driver and from the transcript sync, or a
 * conversation copied onto a session that already held it.
 */

import { withoutHandoff } from "@/lib/agents/session-handoff";

export function shownMessages<T extends { readonly role: string; readonly body: string }>(
    messages: readonly T[]
): T[] {
    const shown: T[] = [];
    for (const message of messages) {
        const body = withoutHandoff(message.body);
        if (!body.trim()) continue;
        const last = shown.at(-1);
        // A person may well send the same line twice; an agent's answer
        // repeated word for word straight after itself is one answer.
        if (last && message.role !== "user" && last.role === message.role && last.body.trim() === body.trim()) continue;
        shown.push(body === message.body ? message : { ...message, body });
    }
    return shown;
}
