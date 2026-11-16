/**
 * A Polaris client for agent sessions, on a Polaris API key.
 *
 * The shape of OpenCode's SDK client (`client.session.create/prompt/abort`,
 * `client.event.subscribe()` as an async iterator) over Polaris's own routes.
 * Every answer is read through the same schema the route answered with, so a
 * response this client does not understand is an error here rather than a
 * value of the wrong type somewhere later.
 */

import type { z } from "zod";
import * as schemas from "./schemas.js";
import { readSse, type SseReader } from "./sse.js";

export interface PolarisClientOptions {
    /** The address Polaris answers at, e.g. https://polaris.example.com. */
    readonly baseUrl: string;
    /** A Polaris API key (`plk_...`) with the Agents permissions the calls need. */
    readonly token: string;
    readonly fetch?: typeof fetch;
    /** How long one call may take before it is given up, in milliseconds. */
    readonly timeoutMs?: number;
}

/** A refusal from Polaris: its status and the sentence it gave. */
export class PolarisApiError extends Error {
    readonly status: number;
    /** Seconds to wait, on a 429. */
    readonly retryAfter: number | null;

    constructor(status: number, message: string, retryAfter: number | null = null) {
        super(message);
        this.name = "PolarisApiError";
        this.status = status;
        this.retryAfter = retryAfter;
    }
}

export interface EventsOptions {
    /** Start after this cursor (a frame's `cursor`, or a session's `cursor`). */
    readonly after?: string;
    readonly signal?: AbortSignal;
    /** Reconnects in a row that may fail before the stream gives up. */
    readonly maxRetries?: number;
}

const DEFAULT_RETRY_MS = 5_000;

/** The origin of a typed address, without a trailing slash. */
function originOf(baseUrl: string): string {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:")
        throw new TypeError("baseUrl must be an http or https address.");
    return url.origin;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}

export function createPolarisClient(options: PolarisClientOptions) {
    const origin = originOf(options.baseUrl);
    const doFetch = options.fetch ?? fetch;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const auth = { authorization: `Bearer ${options.token}` };

    async function refusal(response: Response): Promise<PolarisApiError> {
        const body = schemas.errorSchema.safeParse(await response.json().catch(() => null));
        const retry = Number(response.headers.get("retry-after"));
        return new PolarisApiError(
            response.status,
            body.success ? body.data.error : `Polaris answered ${response.status}.`,
            Number.isFinite(retry) && retry > 0 ? retry : null
        );
    }

    async function call<Schema extends z.ZodTypeAny>(
        method: "GET" | "POST",
        path: string,
        schema: Schema,
        body?: unknown
    ): Promise<z.infer<Schema>> {
        const response = await doFetch(`${origin}${path}`, {
            method,
            headers: body === undefined ? auth : { ...auth, "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
            // A redirect would carry the key to wherever it points.
            redirect: "manual",
            signal: AbortSignal.timeout(timeoutMs)
        });
        if (!response.ok) throw await refusal(response);
        const parsed = schema.safeParse(await response.json().catch(() => undefined));
        if (!parsed.success)
            throw new PolarisApiError(response.status, "Polaris answered in a shape this client does not understand.");
        return parsed.data;
    }

    const session = (id: string) => `/api/v1/sessions/${encodeURIComponent(id)}`;

    /**
     * Follow a session: every event and message from `after` on (or from its
     * start), then its state each time it changes, until it ends. A dropped
     * connection is picked up where it left off with `Last-Event-ID`; nothing
     * is sent twice and nothing is skipped.
     */
    async function* events(id: string, opts: EventsOptions = {}): AsyncGenerator<schemas.StreamFrame> {
        const state: SseReader = { retry: null, lastId: opts.after ?? null };
        const maxRetries = opts.maxRetries ?? 5;
        let failures = 0;
        while (!opts.signal?.aborted) {
            let response: Response;
            try {
                response = await doFetch(`${origin}${session(id)}/events`, {
                    headers: {
                        ...auth,
                        accept: "text/event-stream",
                        ...(state.lastId ? { "last-event-id": state.lastId } : {})
                    },
                    redirect: "manual",
                    signal: opts.signal
                });
            } catch (caught) {
                if (opts.signal?.aborted) return;
                if (++failures > maxRetries) throw caught;
                await wait(state.retry ?? DEFAULT_RETRY_MS, opts.signal);
                continue;
            }
            // A refusal is an answer, not a dropped line: trying again would get the same one.
            if (!response.ok || !response.body) throw await refusal(response);
            try {
                for await (const message of readSse(response.body, state)) {
                    failures = 0;
                    const type = message.event as keyof typeof schemas.STREAM_FRAMES;
                    const frameSchema = schemas.STREAM_FRAMES[type];
                    if (!frameSchema) continue;
                    let json: unknown;
                    try {
                        json = JSON.parse(message.data);
                    } catch {
                        continue;
                    }
                    const parsed = frameSchema.safeParse(json);
                    if (!parsed.success) continue;
                    const frame = { type, cursor: message.id ?? "", data: parsed.data } as schemas.StreamFrame;
                    yield frame;
                    if (frame.type === "end") return;
                }
            } catch (caught) {
                if (opts.signal?.aborted) return;
                if (++failures > maxRetries) throw caught;
            }
            // The server closes a long stream on purpose; it is resumed at once.
            await wait(failures > 0 ? (state.retry ?? DEFAULT_RETRY_MS) : 0, opts.signal);
        }
    }

    return {
        /** Who the key acts as, and its scopes. */
        me: () =>
            call("GET", "/api/v1/me", schemas.meSchema),
        sessions: {
            list: (query: { live?: boolean; after?: string } = {}) => {
                const params = new URLSearchParams();
                if (query.live !== undefined) params.set("live", String(query.live));
                if (query.after) params.set("after", query.after);
                const qs = params.toString();
                return call("GET", `/api/v1/sessions${qs ? `?${qs}` : ""}`, schemas.sessionListSchema);
            },
            get: (id: string) => call("GET", session(id), schemas.sessionDetailSchema),
            create: async (body: schemas.CreateSessionBody) =>
                call("POST", "/api/v1/sessions", schemas.startedSessionSchema, schemas.createSessionBody.parse(body)),
            prompt: async (id: string, body: schemas.PromptSessionBody) =>
                call("POST", `${session(id)}/prompt`, schemas.promptedSchema, schemas.promptSessionBody.parse(body)),
            /** Stop the turn it is on; the session stays up for the next prompt. */
            abort: (id: string) => call("POST", `${session(id)}/abort`, schemas.abortedSchema, {}),
            /** End the session. Its work is pushed the way Stop on the screen pushes it. */
            stop: (id: string) => call("POST", `${session(id)}/stop`, schemas.stoppedSchema, {}),
            events
        }
    };
}

export type PolarisClient = ReturnType<typeof createPolarisClient>;
