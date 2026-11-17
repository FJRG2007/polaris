/**
 * The agent's message while it is being written, live on every page of the
 * session, in this process and in every other (see `draft-frames.ts`).
 *
 * A Chat driver (`acp/session-driver.ts`, `codex/session-driver.ts`) holds a
 * `DraftPublisher`: it is told the message's text as the agent's chunks add to
 * it and sends what was added at most every `DRAFT_EVERY_MS`, so a fast agent
 * is a handful of frames a second rather than one per token. Nothing here is
 * stored: the whole message is still the one history row it always was, and a
 * page that missed the draft reads that row as before.
 *
 * A frame is applied here at once and NOTIFYd on `polaris_agent_draft` for the
 * other processes, cut into pieces small enough for NOTIFY's payload limit.
 * The driver is in one process; the page showing the session may be served by
 * another. A process holds the draft of every session it hears of (bounded),
 * so a page opened part way through a message is sent it whole, and forwards
 * each frame to that session's open streams (`/api/agents/sessions/:id/live`).
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import * as live from "@/lib/live/pg-listener";
import { applyDraftFrame, draftFrameSchema, MAX_DRAFT_CHARS, type Draft, type DraftFrame } from "./draft-frames";

/** The channel drafts are published on. */
export const DRAFT_CHANNEL = "polaris_agent_draft";

/** The shortest gap between two frames of one draft. */
export const DRAFT_EVERY_MS = 200;

/** The most text one notice carries. JSON writes a character in at most six
 *  bytes, so a piece and its envelope stay well under the NOTIFY limit. */
export const PIECE_CHARS = 1_000;

/** Most drafts a process holds at once; the oldest goes first. */
const MAX_HELD = 512;

/** A draft not grown for this long lost its end (its process went away). */
const STALE_MS = 10 * 60_000;

/** This process, so it skips its own notices. */
const NODE = randomUUID();

const noticeSchema = z.object({ n: z.string().uuid(), s: z.string().uuid(), f: draftFrameSchema });

/** What a driver tells about the message being gathered. */
export interface DraftSink {
    /** The message's text so far. A different id ends the last one. */
    set(id: string, text: string): void;
    /** The message is whole, or the turn stopped. */
    end(): void;
}

/** A sink that tells nobody: a driver without drafts. */
export const NO_DRAFTS: DraftSink = { set: () => undefined, end: () => undefined };

interface PublisherOptions {
    everyMs?: number;
    now?: () => number;
}

/**
 * One session's draft, sent as frames of what was added since the last one,
 * at most every `everyMs`. The first text goes at once; the rest of a burst
 * waits out the gap and goes as one frame.
 */
export class DraftPublisher implements DraftSink {
    private id: string | null = null;
    private text = "";
    private sent = 0;
    private lastAt = Number.NEGATIVE_INFINITY;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private readonly everyMs: number;
    private readonly now: () => number;

    constructor(
        private readonly send: (frame: DraftFrame) => void,
        options: PublisherOptions = {}
    ) {
        this.everyMs = options.everyMs ?? DRAFT_EVERY_MS;
        this.now = options.now ?? Date.now;
    }

    set(id: string, text: string): void {
        if (this.id !== null && this.id !== id) this.end();
        this.id = id;
        this.text = text.slice(0, MAX_DRAFT_CHARS);
        if (this.timer) return;
        const wait = this.lastAt + this.everyMs - this.now();
        if (wait <= 0) {
            this.flush();
            return;
        }
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush();
        }, wait);
        this.timer.unref?.();
    }

    end(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        if (this.id !== null && this.sent > 0) this.send({ id: this.id, from: 0, text: "", end: true });
        this.id = null;
        this.text = "";
        this.sent = 0;
    }

    private flush(): void {
        if (this.id === null) return;
        // Text only grows while a message is gathered; one that did not is
        // sent again from the start.
        const from = this.text.length < this.sent ? 0 : this.sent;
        const added = this.text.slice(from);
        if (!added && from === this.sent) return;
        this.send({ id: this.id, from, text: added });
        this.sent = this.text.length;
        this.lastAt = this.now();
    }
}

const hub = new EventEmitter();
// One listener per open stream; the default ceiling of ten is a warning about
// a leak this is not.
hub.setMaxListeners(0);

const held = new Map<string, { draft: Draft; at: number }>();
let listening = false;
let sending: Promise<unknown> = Promise.resolve();
let warned = false;

/** A frame applied to the session's held draft and handed to its streams here. */
function apply(sessionId: string, frame: DraftFrame): void {
    const before = held.get(sessionId)?.draft ?? null;
    const after = applyDraftFrame(before, frame);
    held.delete(sessionId);
    if (after && !after.ended) {
        held.set(sessionId, { draft: after, at: Date.now() });
        if (held.size > MAX_HELD) held.delete(held.keys().next().value!);
    }
    hub.emit(sessionId, frame);
}

/** The session's draft as one frame, for a stream that just opened; null when
 *  no message is being written. */
export function currentDraft(sessionId: string): DraftFrame | null {
    const entry = held.get(sessionId);
    if (!entry) return null;
    if (Date.now() - entry.at > STALE_MS) {
        held.delete(sessionId);
        return null;
    }
    return { id: entry.draft.id, from: 0, text: entry.draft.text };
}

/** The pieces a frame travels as between processes. Pure. */
export function draftNotices(sessionId: string, frame: DraftFrame, node: string = NODE): string[] {
    const wrap = (piece: DraftFrame) => JSON.stringify({ n: node, s: sessionId, f: piece });
    if (frame.end || frame.text.length <= PIECE_CHARS) return [wrap(frame)];
    const pieces: string[] = [];
    for (let at = 0; at < frame.text.length; at += PIECE_CHARS)
        pieces.push(wrap({ id: frame.id, from: frame.from + at, text: frame.text.slice(at, at + PIECE_CHARS) }));
    return pieces;
}

/** Send a frame to this session's pages, here and in every other process. */
export function publishDraft(sessionId: string, frame: DraftFrame): void {
    apply(sessionId, frame);
    for (const payload of draftNotices(sessionId, frame)) {
        if (Buffer.byteLength(payload, "utf8") >= live.NOTIFY_PAYLOAD_LIMIT) return;
        // In order: a later piece overtaking an earlier one reads as a gap.
        sending = sending
            .then(() => prisma.$executeRaw`SELECT pg_notify(${DRAFT_CHANNEL}, ${payload})`)
            .catch((caught: unknown) => {
                if (warned) return;
                warned = true;
                console.error("[agent-session] drafts reach this process only:", caught);
            });
    }
}

/** A notice from another process. */
export function receiveDraftNotice(payload: string): void {
    let parsed: unknown;
    try {
        parsed = JSON.parse(payload);
    } catch {
        return;
    }
    const notice = noticeSchema.safeParse(parsed);
    if (!notice.success || notice.data.n === NODE) return;
    apply(notice.data.s, notice.data.f);
}

/** Be handed every frame of the session's drafts. Returns the unsubscribe. */
export function subscribeDraft(sessionId: string, listener: (frame: DraftFrame) => void): () => void {
    listenAcrossProcesses();
    hub.on(sessionId, listener);
    return () => {
        hub.off(sessionId, listener);
    };
}

function listenAcrossProcesses(): void {
    if (listening) return;
    listening = true;
    try {
        live.pgListener().listen(DRAFT_CHANNEL, { onNotice: receiveDraftNotice });
    } catch (caught) {
        console.error("[agent-session] drafts from other processes are off:", caught);
    }
}

/** The session's publisher, for its Chat driver. */
export function sessionDrafts(sessionId: string): DraftSink {
    return new DraftPublisher((frame) => publishDraft(sessionId, frame));
}
