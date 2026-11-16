/**
 * A JSON-RPC connection to `codex app-server` over a pair of byte streams.
 *
 * The wire is Codex's own (learn.chatgpt.com/docs/app-server, "Protocol"):
 * JSON-RPC 2.0 messages, one per line, with the `"jsonrpc":"2.0"` header
 * left off. That is why the Agent Client Protocol SDK's framing is not used
 * here: it insists on the header. Frames written carry none; frames read may
 * carry it or not.
 *
 * The connection is bidirectional. The server asks the client things - an
 * approval, an answer - and holds the turn until it is answered
 * (`onRequest`); a request nobody models is answered with an error rather
 * than left hanging, since an unanswered one stalls the turn for good.
 *
 * Every inbound line is held to the envelope with Zod before anything reads
 * it, and bounded in size: it comes from a program reading somebody's
 * repository.
 */

import { z } from "zod";
import { MAX_FRAME_BYTES } from "../acp/frames";

const MAX_METHOD_CHARS = 200;

const idSchema = z.union([z.string().max(256), z.number().int().safe()]);
const methodSchema = z.string().min(1).max(MAX_METHOD_CHARS);
const paramsSchema = z.union([z.record(z.unknown()), z.array(z.unknown())]).optional();
const header = { jsonrpc: z.literal("2.0").optional() };

const requestSchema = z.object({ ...header, id: idSchema, method: methodSchema, params: paramsSchema }).strict();
const notificationSchema = z.object({ ...header, method: methodSchema, params: paramsSchema }).strict();
const resultSchema = z
    .object({ ...header, id: idSchema, result: z.unknown() })
    .strict()
    .refine((frame) => "result" in frame, "a response carries a result");
const errorSchema = z
    .object({
        ...header,
        id: idSchema.nullable(),
        error: z
            .object({ code: z.number().int(), message: z.string().max(4_000), data: z.unknown().optional() })
            .strict()
    })
    .strict();

/** The four shapes an app-server frame may take, in the order they are tried. */
export const codexFrameSchema = z.union([requestSchema, notificationSchema, resultSchema, errorSchema]);
export type CodexFrame = z.infer<typeof codexFrameSchema>;

/** A frame as it is read, or null when it is not a JSON-RPC frame. Pure. */
export function readCodexFrame(value: unknown): CodexFrame | null {
    const parsed = codexFrameSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

/** What the server answered with an error, kept for the log. */
export class CodexRpcError extends Error {
    constructor(
        readonly code: number,
        message: string,
        readonly data?: unknown
    ) {
        super(message);
        this.name = "CodexRpcError";
    }
}

/** The JSON-RPC code for a method this client does not answer. */
export const METHOD_NOT_FOUND = -32601;

/** What the connection hands its owner. */
export interface CodexRpcHandlers {
    onNotification(method: string, params: unknown): void;
    /** A server->client request. Resolves to the result; a throw becomes an
     *  error answer. The signal aborts when the connection closes. */
    onRequest(method: string, params: unknown, signal: AbortSignal): Promise<unknown>;
    /** A frame that failed the envelope, by method (never by content). */
    onDropped?(what: string): void;
    onHandlerError?(what: string, error: unknown): void;
}

type Pending = { resolve: (value: unknown) => void; reject: (reason: unknown) => void };

export class CodexRpc {
    private nextId = 1;
    private readonly pending = new Map<string, Pending>();
    private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
    private readonly encoder = new TextEncoder();
    private readonly aborter = new AbortController();
    private writing: Promise<void> = Promise.resolve();
    private ended = false;
    private markClosed: (reason?: unknown) => void = () => undefined;
    /** Resolves once the connection has ended, for any reason. */
    readonly closed: Promise<unknown>;

    constructor(
        streams: { input: ReadableStream<Uint8Array>; output: WritableStream<Uint8Array> },
        private readonly handlers: CodexRpcHandlers
    ) {
        this.closed = new Promise((resolve) => {
            this.markClosed = resolve;
        });
        this.writer = streams.output.getWriter();
        void this.readLoop(streams.input);
    }

    /** Ask the server something; resolves to its result. */
    request(method: string, params: unknown): Promise<unknown> {
        if (this.ended) return Promise.reject(new Error("The connection to the agent has ended."));
        const id = this.nextId++;
        const answer = new Promise<unknown>((resolve, reject) => {
            this.pending.set(String(id), { resolve, reject });
        });
        this.send({ id, method, params }).catch((error: unknown) => this.settle(String(id), undefined, error));
        return answer;
    }

    /** Tell the server something that wants no answer. */
    notify(method: string, params: unknown): Promise<void> {
        if (this.ended) return Promise.reject(new Error("The connection to the agent has ended."));
        return this.send(params === undefined ? { method } : { method, params });
    }

    /** End the connection. Every open request fails with `reason`. */
    close(reason?: unknown): void {
        if (this.ended) return;
        this.ended = true;
        this.aborter.abort();
        const error = reason ?? new Error("The connection to the agent was closed.");
        for (const [id, entry] of this.pending) {
            this.pending.delete(id);
            entry.reject(error);
        }
        this.writer.close().catch(() => undefined);
        this.markClosed(reason);
    }

    private send(frame: Record<string, unknown>): Promise<void> {
        const bytes = this.encoder.encode(`${JSON.stringify(frame)}\n`);
        const next = this.writing.then(() => this.writer.write(bytes));
        this.writing = next.catch(() => undefined);
        return next;
    }

    private settle(id: string, result: unknown, error?: unknown): void {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        if (error !== undefined) entry.reject(error);
        else entry.resolve(result);
    }

    private async readLoop(input: ReadableStream<Uint8Array>): Promise<void> {
        const reader = input.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let newline = buffer.indexOf("\n");
                while (newline >= 0) {
                    this.dispatch(buffer.slice(0, newline));
                    buffer = buffer.slice(newline + 1);
                    newline = buffer.indexOf("\n");
                }
                // A line longer than any frame Polaris reads is never going to
                // be one; holding it would let one session fill the memory.
                if (buffer.length > MAX_FRAME_BYTES) throw new Error("The agent sent a line longer than Polaris reads.");
            }
            this.close();
        } catch (error) {
            this.close(error);
        } finally {
            reader.releaseLock();
        }
    }

    private dispatch(line: string): void {
        if (!line.trim()) return;
        let value: unknown;
        try {
            value = JSON.parse(line);
        } catch {
            this.handlers.onDropped?.("unparsable");
            return;
        }
        const frame = readCodexFrame(value);
        if (!frame) {
            const method = (value as { method?: unknown } | null)?.method;
            this.handlers.onDropped?.(typeof method === "string" ? method.slice(0, MAX_METHOD_CHARS) : "response");
            return;
        }
        if ("method" in frame && "id" in frame) return void this.answer(frame.id, frame.method, frame.params);
        if ("method" in frame) {
            try {
                this.handlers.onNotification(frame.method, frame.params);
            } catch (error) {
                this.handlers.onHandlerError?.(frame.method, error);
            }
            return;
        }
        if ("error" in frame) {
            if (frame.id === null) return;
            this.settle(String(frame.id), undefined, new CodexRpcError(frame.error.code, frame.error.message, frame.error.data));
            return;
        }
        this.settle(String(frame.id), frame.result);
    }

    private async answer(id: string | number, method: string, params: unknown): Promise<void> {
        let reply: Record<string, unknown>;
        try {
            const result = await this.handlers.onRequest(method, params, this.aborter.signal);
            reply = { id, result: result ?? {} };
        } catch (error) {
            const code = error instanceof CodexRpcError ? error.code : -32000;
            const message = error instanceof CodexRpcError ? error.message : "The client could not answer that.";
            if (!(error instanceof CodexRpcError)) this.handlers.onHandlerError?.(method, error);
            reply = { id, error: { code, message } };
        }
        if (this.ended) return;
        await this.send(reply).catch(() => undefined);
    }
}
