/**
 * The session API's wire shapes, written once.
 *
 * The routes under `/api/v1/sessions` parse their requests with these, the API
 * reference documents them from these, and the client below reads its answers
 * through them. There is no second copy to drift: a field added here is a field
 * the route reads, the reference shows and the client types.
 */

import { z } from "zod";

/** Where a session is in its life. The same list as the Agents app's. */
export const SESSION_STATES = [
    "queued",
    "starting",
    "working",
    "waiting",
    "idle",
    "stopped",
    "failed"
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/** A session nobody can send anything to any more. */
export function isSessionOver(state: SessionState): boolean {
    return state === "stopped" || state === "failed";
}

/** The most a prompt may be, the same ceiling the screen and the MCP tools hold. */
export const PROMPT_MAX = 20_000;

const promptText = z.string().trim().min(1).max(PROMPT_MAX);

/** POST /api/v1/sessions */
export const createSessionBody = z
    .object({
        /** What to ask the agent to do. Delivered as its first prompt. */
        prompt: promptText,
        /** The repository, as "owner/name". Empty opens a workspace with nothing checked out. */
        repo: z.string().trim().max(140).default(""),
        /** What the session is for, in a few words. The prompt's start when left out. */
        title: z.string().trim().max(80).default(""),
        /** Which coding agent runs it. */
        agent: z.string().trim().min(1).max(40).default("claude"),
        /** The branch to start from. Empty takes the repository's default. */
        baseRef: z.string().trim().max(200).default(""),
        /** The model, as "provider/model", from the ones this person can start
         *  the agent on. Empty takes the agent's own default. */
        model: z.string().trim().max(265).default("")
    })
    .strict();
export type CreateSessionBody = z.input<typeof createSessionBody>;

/** POST /api/v1/sessions/{id}/prompt */
export const promptSessionBody = z.object({ text: promptText }).strict();
export type PromptSessionBody = z.input<typeof promptSessionBody>;

/** GET /api/v1/sessions */
export const listSessionsQuery = z
    .object({
        /** Only the sessions that have not ended. */
        live: z
            .enum(["true", "false"])
            .default("false")
            .transform((value) => value === "true"),
        /** The `next` of the previous page. */
        after: z.string().trim().min(1).max(80).optional()
    })
    .strict();

/**
 * Where a reader of a session's stream has got to: the last event and the last
 * message it was sent, each as its time in milliseconds and its id. Sent as the
 * id of every frame, so a stream dropped anywhere picks up after the last frame
 * that arrived (`Last-Event-ID`).
 */
export interface StreamCursor {
    readonly event: { readonly at: number; readonly id: string } | null;
    readonly message: { readonly at: number; readonly id: string } | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cursorPart(part: StreamCursor["event"]): string {
    return part ? `${part.at}.${part.id}` : "0";
}

function readPart(text: string): StreamCursor["event"] | undefined {
    if (text === "0") return null;
    const dot = text.indexOf(".");
    if (dot < 1) return undefined;
    const at = Number(text.slice(0, dot));
    const id = text.slice(dot + 1);
    if (!Number.isSafeInteger(at) || at < 0 || !UUID.test(id)) return undefined;
    return { at, id: id.toLowerCase() };
}

export function streamCursor(cursor: StreamCursor): string {
    return `${cursorPart(cursor.event)}~${cursorPart(cursor.message)}`;
}

/** A cursor read back, or null when the text is not one. */
export function readStreamCursor(text: string): StreamCursor | null {
    if (text.length > 120) return null;
    const [event, message, ...rest] = text.trim().split("~");
    if (event === undefined || message === undefined || rest.length > 0) return null;
    const e = readPart(event);
    const m = readPart(message);
    if (e === undefined || m === undefined) return null;
    return { event: e, message: m };
}

export const streamCursorSchema = z
    .string()
    .trim()
    .max(120)
    .refine((value) => readStreamCursor(value) !== null, "Not a stream cursor.");

/** GET /api/v1/sessions/{id}/events */
export const sessionEventsQuery = z
    .object({
        /** Start after this cursor, for a client that cannot set `Last-Event-ID`. */
        after: streamCursorSchema.optional()
    })
    .strict();

/** One session, as the API answers it. */
export const sessionSchema = z.object({
    id: z.string(),
    title: z.string(),
    state: z.enum(SESSION_STATES),
    /** "owner/name", or empty for a workspace. */
    repo: z.string(),
    branch: z.string(),
    agent: z.string(),
    /** What it was last doing, in a line. */
    detail: z.string(),
    error: z.string().nullable(),
    pullRequest: z.object({ number: z.number().int(), url: z.string() }).nullable(),
    createdAt: z.string(),
    finishedAt: z.string().nullable()
});
export type Session = z.infer<typeof sessionSchema>;

export const sessionListSchema = z.object({
    sessions: z.array(sessionSchema),
    /** Pass as `after` for the next page; null on the last one. */
    next: z.string().nullable()
});

export const sessionDetailSchema = z.object({
    session: sessionSchema,
    /** Where its stream is now: pass as `after` to read only what comes next. */
    cursor: z.string()
});

export const startedSessionSchema = z.object({
    session: sessionSchema,
    /** Its place in line when every slot is taken, or null when it started. */
    queuedAt: z.number().int().nullable()
});

export const promptedSchema = z.object({ sent: z.literal(true) });
export const abortedSchema = z.object({ aborted: z.literal(true) });
export const stoppedSchema = z.object({ stopped: z.literal(true) });

/** Something the agent did: a tool call, a turn ending, a question. */
export const eventFrameSchema = z.object({
    id: z.string(),
    kind: z.string(),
    detail: z.string(),
    subject: z.string(),
    at: z.string()
});

/** Something said in the session: a prompt, the agent's answer, a tool call or its result. */
export const messageFrameSchema = z.object({
    id: z.string(),
    role: z.enum(["user", "agent", "system"]),
    kind: z.string(),
    subject: z.string(),
    body: z.string(),
    at: z.string()
});

export const endFrameSchema = z.object({ state: z.enum(SESSION_STATES) });

/** Every frame the event stream sends, by its SSE `event` name. */
export const STREAM_FRAMES = {
    session: sessionSchema,
    event: eventFrameSchema,
    message: messageFrameSchema,
    end: endFrameSchema
} as const;

export type StreamFrame =
    | { readonly type: "session"; readonly cursor: string; readonly data: Session }
    | { readonly type: "event"; readonly cursor: string; readonly data: z.infer<typeof eventFrameSchema> }
    | { readonly type: "message"; readonly cursor: string; readonly data: z.infer<typeof messageFrameSchema> }
    | { readonly type: "end"; readonly cursor: string; readonly data: z.infer<typeof endFrameSchema> };

export const errorSchema = z.object({ error: z.string() }).passthrough();

/** GET /api/v1/me, the part a client reads. */
export const meSchema = z.object({
    user: z.object({ id: z.string(), email: z.string() }).passthrough(),
    key: z.object({ id: z.string(), scopes: z.array(z.string()) })
});
