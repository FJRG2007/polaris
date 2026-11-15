/**
 * What an inbound Agent Client Protocol frame has to look like before anything
 * reads it.
 *
 * The frame comes from a program reading somebody's repository, so it is held
 * to the JSON-RPC envelope here - version, id, method, and a result or an
 * error but never both - before the SDK dispatches it. The SDK then parses
 * each known method's params against its own generated schema
 * (`@agentclientprotocol/sdk`'s `zod.gen`), so a frame that reaches a handler
 * has passed both. A frame that fails here is dropped and counted, never
 * guessed at.
 */

import { z } from "zod";
import type { AnyMessage } from "@agentclientprotocol/sdk";

/** The longest one frame may be. A tool's diff of a large file is the biggest
 *  thing an agent legitimately sends; this bounds the memory one session can
 *  make the dashboard hold for one line. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

const MAX_METHOD_CHARS = 200;

const idSchema = z.union([z.string().max(256), z.number().int().safe()]);
const methodSchema = z.string().min(1).max(MAX_METHOD_CHARS);
const paramsSchema = z.union([z.record(z.unknown()), z.array(z.unknown())]).optional();

const requestSchema = z
    .object({ jsonrpc: z.literal("2.0"), id: idSchema, method: methodSchema, params: paramsSchema })
    .strict();

const notificationSchema = z
    .object({ jsonrpc: z.literal("2.0"), method: methodSchema, params: paramsSchema })
    .strict();

const resultSchema = z
    .object({ jsonrpc: z.literal("2.0"), id: idSchema, result: z.unknown() })
    .strict()
    .refine((frame) => "result" in frame, "a response carries a result");

const errorSchema = z
    .object({
        jsonrpc: z.literal("2.0"),
        id: idSchema.nullable(),
        error: z
            .object({ code: z.number().int(), message: z.string().max(4_000), data: z.unknown().optional() })
            .strict()
    })
    .strict();

/** The four shapes a JSON-RPC frame may take, in the order they are tried. */
export const frameSchema = z.union([requestSchema, notificationSchema, resultSchema, errorSchema]);

/** A frame as the SDK takes it, or null when it is not a JSON-RPC frame. */
export function readFrame(value: unknown): AnyMessage | null {
    const parsed = frameSchema.safeParse(value);
    return parsed.success ? (parsed.data as AnyMessage) : null;
}

/**
 * A stream that passes on only the frames `readFrame` accepts, and reports the
 * rest by method (or `response`) - never by content, which is the agent's.
 */
export function validatedFrames(
    onDropped: (what: string) => void
): TransformStream<AnyMessage, AnyMessage> {
    return new TransformStream<AnyMessage, AnyMessage>({
        transform(message, controller) {
            const frame = readFrame(message);
            if (frame) {
                controller.enqueue(frame);
                return;
            }
            const method = (message as { method?: unknown } | null)?.method;
            onDropped(typeof method === "string" ? method.slice(0, MAX_METHOD_CHARS) : "response");
        }
    });
}
