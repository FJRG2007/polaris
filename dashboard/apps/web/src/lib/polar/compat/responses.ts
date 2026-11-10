/**
 * `POST /v1/responses`: the OpenAI Responses API in front of Polar's routing,
 * the API Codex speaks (free-claude-code `api/routes.py`,
 * `create_response`). The model id routes as on every other wire
 * (`route-model.ts`), and the answer names back the id the client sent.
 */

import { compatCaller } from "@/lib/polar/compat/auth";
import { compatError, errorResponse, isCompatError, type CompatErrorType } from "@/lib/polar/compat/errors";
import {
    customToolNames,
    responsesReasoning,
    responsesRequestSchema,
    responsesToModelMessages,
    responsesToolChoiceOf,
    responsesToolsOf
} from "@/lib/polar/compat/responses-request";
import { textTokens } from "@/lib/polar/compat/tokens";
import { SSE_HEADERS, sseFrame, type SseEvent } from "@/lib/polar/compat/anthropic-stream";
import { ResponsesStreamWriter, aggregateResponse } from "@/lib/polar/compat/responses-stream";
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

export async function createResponse(request: Request): Promise<Response> {
    const caller = await compatCaller(request);
    if (isCompatError(caller)) return errorResponse(caller, "openai");
    const body = await readJsonBody(request, responsesRequestSchema);
    if (isCompatError(body)) return errorResponse(body, "openai");
    if (body.previous_response_id) {
        return errorResponse(
            compatError(
                "invalid_request_error",
                "previous_response_id is not supported: Polaris keeps no responses. Send the whole conversation in input, with store set to false."
            ),
            "openai"
        );
    }

    const call: CompatCall = {
        caller,
        model: body.model,
        reasoning: responsesReasoning(body),
        messages: responsesToModelMessages(body),
        tools: responsesToolsOf(body.tools),
        toolChoice: responsesToolChoiceOf(body.tool_choice),
        maxOutputTokens: body.max_output_tokens ?? undefined,
        temperature: body.temperature ?? undefined,
        topP: body.top_p ?? undefined,
        signal: request.signal
    };
    const prepared = await prepareCall(call);
    if (isCompatError(prepared)) return errorResponse(prepared, "openai");
    const opened = await openCall(call, prepared);
    if (isCompatError(opened)) return errorResponse(opened, "openai");

    const writer = new ResponsesStreamWriter({
        model: body.model,
        inputTokens: Math.max(1, textTokens(JSON.stringify(body.input) + (body.instructions ?? ""))),
        customTools: customToolNames(body.tools),
        echo: {
            tools: body.tools ?? [],
            tool_choice: body.tool_choice ?? "auto",
            parallel_tool_calls: body.parallel_tool_calls ?? true,
            instructions: body.instructions,
            max_output_tokens: body.max_output_tokens,
            temperature: body.temperature,
            top_p: body.top_p,
            metadata: body.metadata,
            reasoning: body.reasoning
        }
    });
    const wire: WireWriter<SseEvent> = {
        start: () => writer.start(),
        part: (part) => writer.part(part),
        finish: (finish) => writer.finish({ finishReason: finish.finishReason, usage: finish.totalUsage }),
        error: (error) => writer.error(error)
    };
    const frames = answerFrames(opened, wire);
    if (body.stream) return new Response(streamBody(frames, sseFrame), { headers: SSE_HEADERS });
    const response = aggregateResponse(await allFrames(frames));
    if (response.status === "failed") {
        const error = response.error as { type: CompatErrorType; message: string };
        return errorResponse({ type: error.type, message: error.message }, "openai");
    }
    return Response.json(response);
}
