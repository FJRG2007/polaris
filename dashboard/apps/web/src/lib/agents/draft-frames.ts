/**
 * The agent's message while it is still being written, as the session page
 * draws it: a "draft" that grows under the last stored row and is replaced by
 * that row once the message is whole.
 *
 * History rows stay whole messages (`acp/normalize.ts`, `codex/normalize.ts`);
 * a draft is never stored. It travels as frames: `from` is where `text` goes
 * in the draft, so a frame carries only what was added since the last one,
 * and `end` says the message is whole (or the turn stopped). The same pure
 * step applies a frame on the server (`session-drafts.ts`) and on the page,
 * so both read a frame alike. Shared with the browser: nothing here touches
 * Node.
 */

import { z } from "zod";

/** The most of a draft kept or drawn: the stored row's own bound
 *  (`MAX_TEXT_CHARS` in `transcript-decoders.ts`). */
export const MAX_DRAFT_CHARS = 12_000;

/** How long an ended draft may stay on screen waiting for its row. */
export const DRAFT_LINGER_MS = 5_000;

/** Room for an agent's own message id (Codex's run to 256) and a suffix. */
const MAX_DRAFT_ID_CHARS = 300;

export const draftFrameSchema = z.object({
    id: z.string().min(1).max(MAX_DRAFT_ID_CHARS),
    from: z.number().int().min(0).max(MAX_DRAFT_CHARS),
    text: z.string().max(MAX_DRAFT_CHARS),
    end: z.literal(true).optional()
});
export type DraftFrame = z.infer<typeof draftFrameSchema>;

export interface Draft {
    readonly id: string;
    readonly text: string;
    /** The message is whole: drawn until its row lands, never grown again. */
    readonly ended: boolean;
}

/**
 * A frame applied to the draft it follows. Pure.
 *
 * - A new id starts a new draft in place of the last; it must begin at the
 *   start, or the reader joined part way through and has nothing to show.
 * - A frame that starts past what this reader has means frames were missed:
 *   the draft is dropped rather than drawn with a hole in it. The stored row
 *   still arrives when the message is whole.
 * - A frame that starts inside it (a repeat) overwrites from there.
 * - An end frame ends the draft of its own id and nothing else.
 */
export function applyDraftFrame(current: Draft | null, frame: DraftFrame): Draft | null {
    if (frame.end) {
        if (!current || current.id !== frame.id) return current;
        return current.ended ? current : { ...current, ended: true };
    }
    const base = current && current.id === frame.id && !current.ended ? current.text : "";
    if (frame.from > base.length) return null;
    const text = `${base.slice(0, frame.from)}${frame.text}`.slice(0, MAX_DRAFT_CHARS);
    return { id: frame.id, text, ended: false };
}

/** The first characters a draft and its stored row are matched on. */
const MATCH_CHARS = 64;

/**
 * Whether the stored message this draft became is among `messages` (the
 * agent's messages of the thread, newest last): the row is the draft's text
 * trimmed and cut to the same bound, so it starts as the draft does. Pure.
 */
export function draftLanded(draft: Draft, messages: readonly string[]): boolean {
    const head = draft.text.trim().slice(0, MATCH_CHARS);
    if (!head) return true;
    for (let i = messages.length - 1; i >= 0 && i >= messages.length - 3; i--) {
        if (messages[i]!.trim().startsWith(head)) return true;
    }
    return false;
}
