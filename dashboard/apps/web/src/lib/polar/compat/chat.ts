/**
 * `POST /v1/chat/completions`: OpenAI Chat Completions in front of Polar's
 * routing, for Codex, OpenCode, Cline, Aider and any OpenAI-compatible
 * client. The model id routes as it does on the Anthropic wire
 * (`route-model.ts`), and the answer names back the id the client sent.
 */

import { compatCaller } from "@/lib/polar/compat/auth";
import { errorResponse, isCompatError, type CompatErrorType } from "@/lib/polar/compat/errors";
import {
    chatReasoning,
    chatRequestSchema,
    chatToModelMessages,
    chatToolChoiceOf,
    chatToolsOf
} from "@/lib/polar/compat/openai-request";
import {
    ChatStreamWriter,
    aggregateCompletion,
    chunkFrame,
    openaiUsage,
    type Chunk
} from "@/lib/polar/compat/openai-stream";
import { textTokens } from "@/lib/polar/compat/tokens";
import { SSE_HEADERS } from "@/lib/polar/compat/anthropic-stream";
import {
    allFrames,
    answerFrames,
    openCall,
    prepareCall,
    readJsonBody,
    type CompatCall,
    type WireWriter
} from "@/lib/polar/compat/run";
import { streamBody } from "@/lib/polar/compat/stream-body";

type Frame = Chunk | "[DONE]";

export async function createChatCompletion(request: Request): Promise<Response> {
    const caller = await compatCaller(request);
    if (isCompatError(caller)) return errorResponse(caller, "openai");
    const body = await readJsonBody(request, chatRequestSchema);
    if (isCompatError(body)) return errorResponse(body, "openai");

    const call: CompatCall = {
        caller,
        model: body.model,
        reasoning: chatReasoning(body),
        messages: chatToModelMessages(body.messages),
        tools: chatToolsOf(body.tools),
        toolChoice: chatToolChoiceOf(body.tool_choice),
        maxOutputTokens: body.max_completion_tokens ?? body.max_tokens ?? undefined,
        temperature: body.temperature ?? undefined,
        topP: body.top_p ?? undefined,
        presencePenalty: body.presence_penalty ?? undefined,
        frequencyPenalty: body.frequency_penalty ?? undefined,
        seed: body.seed ?? undefined,
        stopSequences: body.stop == null ? undefined : typeof body.stop === "string" ? [body.stop] : body.stop,
        signal: request.signal
    };
    const prepared = await prepareCall(call);
    if (isCompatError(prepared)) return errorResponse(prepared, "openai");
    const opened = await openCall(call, prepared);
    if (isCompatError(opened)) return errorResponse(opened, "openai");

    const inputTokens = Math.max(1, textTokens(JSON.stringify(body.messages)));
    const streaming = body.stream === true;
    const writer = new ChatStreamWriter({
        model: body.model,
        inputTokens,
        includeUsage: streaming && body.stream_options?.include_usage === true
    });
    let usage: unknown = openaiUsage({}, inputTokens);
    const wire: WireWriter<Frame> = {
        start: () => writer.start(),
        part: (part) => writer.part(part),
        finish: (finish) => {
            usage = openaiUsage(finish.totalUsage, inputTokens);
            return writer.finish({ finishReason: finish.finishReason, usage: finish.totalUsage });
        },
        error: (error) => writer.error(error)
    };
    const frames = answerFrames(opened, wire);
    if (streaming) return new Response(streamBody(frames, chunkFrame), { headers: SSE_HEADERS });
    const completion = aggregateCompletion(await allFrames(frames), usage);
    if ("error" in completion) {
        const error = completion.error as { type: CompatErrorType; message: string };
        return errorResponse({ type: error.type, message: error.message }, "openai");
    }
    return Response.json(completion);
}
