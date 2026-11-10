/**
 * `POST /v1/messages` and `POST /v1/messages/count_tokens`: the Anthropic
 * Messages API in front of Polar's routing, for Claude Code and any client
 * built on Anthropic's SDK (free-claude-code `api/routes.py`). The answer names
 * back the model id the client sent, as free-claude-code does, so a client
 * that checks it sees what it asked for.
 */

import { compatCaller } from "@/lib/polar/compat/auth";
import { errorResponse, isCompatError as isError, type CompatError } from "@/lib/polar/compat/errors";
import {
    clientReasoning,
    messagesRequestSchema,
    systemMessages,
    toModelMessages,
    toolChoiceOf,
    toolsOf
} from "@/lib/polar/compat/anthropic-request";
import {
    AnthropicStreamWriter,
    SSE_HEADERS,
    aggregateMessage,
    sseFrame,
    type SseEvent
} from "@/lib/polar/compat/anthropic-stream";
import { countRequestTokens } from "@/lib/polar/compat/tokens";
import { NO_THINKING_PREFIX } from "@/lib/polar/compat/route-model";
import {
    allFrames,
    answerFrames,
    openCall,
    prepareCall,
    readJsonBody,
    type WireWriter
} from "@/lib/polar/compat/run";
import { streamBody } from "@/lib/polar/compat/stream-body";

export async function createMessage(request: Request): Promise<Response> {
    const caller = await compatCaller(request);
    if (isError(caller)) return errorResponse(caller, "anthropic");
    const body = await readJsonBody(request, messagesRequestSchema);
    if (isError(body)) return errorResponse(body, "anthropic");

    const messages = [...systemMessages(body.system), ...toModelMessages(body.messages)];
    const reasoning = clientReasoning(body);
    const call = {
        caller,
        model: body.model,
        reasoning,
        messages,
        tools: toolsOf(body.tools),
        toolChoice: toolChoiceOf(body.tool_choice),
        maxOutputTokens: body.max_tokens,
        temperature: body.temperature,
        topP: body.top_p,
        topK: body.top_k,
        stopSequences: body.stop_sequences,
        signal: request.signal
    };
    const prepared = await prepareCall(call);
    if (isError(prepared)) return errorResponse(prepared, "anthropic");
    const opened = await openCall(call, prepared);
    if (isError(opened)) return errorResponse(opened, "anthropic");

    const writer = new AnthropicStreamWriter({
        model: body.model,
        inputTokens: countRequestTokens(body),
        // A client that turned thinking off, or an id that does not think, is
        // sent none.
        thinking: reasoning !== "none" && !body.model.startsWith(NO_THINKING_PREFIX)
    });
    const wire: WireWriter<SseEvent> = {
        start: () => writer.start(),
        part: (part) => writer.part(part),
        finish: (finish) =>
            writer.finish({
                finishReason: finish.finishReason,
                rawFinishReason: finish.rawFinishReason,
                usage: finish.totalUsage
            }),
        error: (error) => writer.error(error)
    };
    const frames = answerFrames(opened, wire);
    if (body.stream) {
        return new Response(streamBody(frames, sseFrame, sseFrame({ event: "ping", data: { type: "ping" } })), { headers: SSE_HEADERS });
    }
    const message = aggregateMessage(await allFrames(frames));
    if (message.type === "error") {
        const error = message.error as CompatError;
        return errorResponse(error, "anthropic");
    }
    return Response.json(message);
}

export async function countTokens(request: Request): Promise<Response> {
    const caller = await compatCaller(request);
    if (isError(caller)) return errorResponse(caller, "anthropic");
    const body = await readJsonBody(request, messagesRequestSchema);
    if (isError(body)) return errorResponse(body, "anthropic");
    return Response.json({ input_tokens: countRequestTokens(body) });
}
