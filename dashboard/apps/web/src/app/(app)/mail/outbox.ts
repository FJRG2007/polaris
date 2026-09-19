/**
 * The composer's four requests: write the draft, send, take it back, send now.
 *
 * Plain `fetch`es against `/api/mail/drafts` and `/api/mail/outbox`, never
 * server actions - the router runs those one at a time and can drop one that is
 * dispatched while a navigation is loading, and a composer awaiting an answer
 * that never comes held every link in Polaris with it. What comes back is
 * validated: a tab left open across an update is talking to a server that may
 * answer in a shape it has not seen, and that has to read as a refusal rather
 * than as a message that went.
 */

import { z } from "zod";
import type { DraftFields } from "./draft-saves";

/** What a send carries on top of the draft. */
export interface Outgoing extends DraftFields {
    readonly inReplyToId: string | null;
    readonly forward: boolean;
    readonly sendAt: Date | null;
    readonly draftId: string | null;
}

/** A refusal, in words somebody can act on. */
export interface Refused {
    readonly error: string;
}

const refusedSchema = z.object({ error: z.string() });
const savedSchema = z.object({ draftId: z.string() });
const queuedSchema = z.object({ draftId: z.string(), sendAt: z.string() });
const undoneSchema = z.object({ undone: z.boolean() });
const sentSchema = z.object({ sent: z.boolean() });

/** Said when the answer is not one this tab understands, or never arrived. */
const UNREACHABLE = "Polaris could not be reached. Try again.";

async function ask<T>(
    url: string,
    init: RequestInit,
    schema: z.ZodType<T>,
    fallback: string
): Promise<T | Refused> {
    let body: unknown;
    try {
        const response = await fetch(url, { ...init, cache: "no-store" });
        body = await response.json().catch(() => null);
        if (!response.ok) {
            const refused = refusedSchema.safeParse(body);
            return { error: refused.success ? refused.data.error : fallback };
        }
    } catch {
        return { error: UNREACHABLE };
    }
    const parsed = schema.safeParse(body);
    return parsed.success ? parsed.data : { error: fallback };
}

function json(method: string, payload: unknown): RequestInit {
    return {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
    };
}

/** Whether an answer is a refusal. */
export function isRefused(outcome: object): outcome is Refused {
    return "error" in outcome;
}

/** Write the draft, answering with its id. */
export function saveDraft(fields: DraftFields, id: string | null) {
    return ask(
        "/api/mail/drafts",
        json("POST", { id, ...fields }),
        savedSchema,
        "That draft could not be saved."
    );
}

/** Put a message in the queue, answering with its draft and when it goes. */
export function queueMessage(message: Outgoing) {
    return ask(
        "/api/mail/outbox",
        json("POST", message),
        queuedSchema,
        "That message could not be sent."
    );
}

/** Take a queued message back. `undone` is false when it had already gone. */
export function undoSend(draftId: string) {
    return ask(
        `/api/mail/outbox/${encodeURIComponent(draftId)}`,
        { method: "DELETE" },
        undoneSchema,
        "That message has already gone."
    );
}

/** Send a queued message without waiting out the rest of its delay. */
export function sendNow(draftId: string) {
    return ask(
        `/api/mail/outbox/${encodeURIComponent(draftId)}`,
        { method: "POST" },
        sentSchema,
        "That message could not be sent now."
    );
}
