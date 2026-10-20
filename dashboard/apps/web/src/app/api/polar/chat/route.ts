/**
 * POST /api/polar/chat - one turn with Polar, streamed.
 *
 * A route rather than a server action: an action is bound to the build that
 * served the page, and dies across an update in the middle of a conversation.
 *
 * Session-authenticated, body validated before anything is believed. The model
 * is one the person can spend a key on; the tools are Polaris's own MCP tools
 * run as the person, and any that can change something waits for an approval
 * in the chat (`toolApproval`). The page context arrives fenced as data.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import {
    convertToModelMessages,
    isStepCount,
    safeValidateUIMessages,
    streamText,
    type UIMessage
} from "ai";
import { apiUser } from "@/lib/api-session";
import { polarTools } from "@/lib/polar/tools";
import { polarSystemPrompt } from "@/lib/polar/prompt";
import { readCappedBody } from "@/lib/request-body";
import { rateLimit } from "@/lib/rate-limit-service";
import { inlinePolarFiles } from "@/lib/polar/attachments";
import { startPolarTitle } from "@/lib/polar/titles";
import { ensurePolarThread, polarThreadInstructions, savePolarMessages } from "@/lib/polar/threads";
import { polarModelOptions, reasoningFor, resolvePolarModel } from "@/lib/polar/models";
import {
    fencePageContext,
    modelChoiceSchema,
    pageContextSchema,
    type ModelChoice
} from "@/lib/polar/shared";

export const dynamic = "force-dynamic";

/** Biggest request accepted: a conversation plus a few pictures. */
const BODY_MAX = 12 * 1024 * 1024;
/** Most messages one request may carry. */
const MESSAGE_MAX = 400;
/** Most tool steps one turn may take before it has to answer. */
const STEP_MAX = 12;

const bodySchema = z.object({
    threadId: z.string().uuid(),
    messages: z.array(z.unknown()).min(1).max(MESSAGE_MAX),
    choice: modelChoiceSchema,
    context: pageContextSchema.nullable().default(null),
    /** The message the newest one follows: its parent, for edit versions. */
    parentId: z.string().max(64).nullable().default(null),
    /** The project a new thread is filed under; ignored for an existing one. */
    projectId: z.string().uuid().nullable().default(null)
});

function refuse(code: string, status: number): NextResponse {
    return NextResponse.json({ error: code }, { status });
}

/** The first text of a user message, for a new thread's title. */
function firstText(message: UIMessage | undefined): string {
    const part = message?.parts.find((entry) => entry.type === "text");
    return part && "text" in part ? part.text : "";
}

export async function POST(request: Request): Promise<Response> {
    const user = await apiUser();
    if (user instanceof NextResponse) return user;
    // An administrator looking through somebody else's eyes is not that person,
    // and Polar does things in its user's name.
    if (user.viewingAs) return refuse("view_as", 403);

    const limited = await rateLimit(`polar-chat:${user.id}`, 30, 60_000);
    if (!limited.ok) return refuse("rate_limited", 429);

    const bytes = await readCappedBody(request, BODY_MAX);
    if (!bytes) return refuse("too_large", 413);
    let raw: unknown;
    try {
        raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return refuse("invalid", 400);
    }
    const body = bodySchema.safeParse(raw);
    if (!body.success) return refuse("invalid", 400);

    const toolset = await polarTools(user);
    const checked = await safeValidateUIMessages({
        messages: body.data.messages,
        tools: toolset.tools as never
    });
    if (!checked.success) return refuse("invalid", 400);
    const messages = checked.data as UIMessage[];

    // A thread whose model has since been retired by its provider falls back to
    // the first model this person can use, and the answer says so.
    let choice: ModelChoice = body.data.choice;
    let resolved = await resolvePolarModel(user.id, choice);
    let fellBackFrom: string | null = null;
    if (resolved === "unknown_model") {
        const first = (await polarModelOptions(user.id))[0]?.models[0];
        if (first) {
            fellBackFrom = choice.model;
            choice = { ...choice, provider: first.provider, model: first.model, payer: null };
            resolved = await resolvePolarModel(user.id, choice);
        }
    }
    if (typeof resolved === "string") return refuse(resolved, 409);

    const owned = await ensurePolarThread(
        user.id,
        body.data.threadId,
        firstText(messages[0]),
        choice,
        body.data.projectId
    );
    if (!owned) return refuse("not_found", 404);
    const instructions = await polarThreadInstructions(user.id, body.data.threadId);

    const parentFor = (index: number, list: readonly UIMessage[]): string | null =>
        index === list.length - 1 && list[index]?.role === "user"
            ? body.data.parentId
            : (list[index - 1]?.id ?? null);

    const startedAt = Date.now();
    const result = streamText({
        model: resolved.model,
        system: polarSystemPrompt(user.name, fencePageContext(body.data.context), instructions),
        messages: await convertToModelMessages(await inlinePolarFiles(user.id, messages)),
        tools: toolset.tools,
        toolApproval: toolset.approval,
        stopWhen: isStepCount(STEP_MAX),
        reasoning: reasoningFor(choice.intelligence, resolved.option),
        abortSignal: request.signal
    });

    return result.toUIMessageStreamResponse({
        originalMessages: messages,
        sendReasoning: true,
        messageMetadata: ({ part }) =>
            part.type === "start"
                ? {
                      model: resolved.option.name,
                      provider: resolved.option.providerName,
                      payer: resolved.credential.source,
                      fellBackFrom
                  }
                : part.type === "finish"
                  ? // How long the turn worked, for the line its steps fold into.
                    { workedMs: Date.now() - startedAt }
                  : undefined,
        onFinish: async ({ messages: finished }) => {
            try {
                await savePolarMessages(user.id, body.data.threadId, finished, (index) =>
                    parentFor(index, finished)
                );
            } catch (error) {
                console.error("polar: could not save the turn", error);
            }
            // A new thread is named by its model once the first answer is in,
            // behind the reply; the screen asks for the title when it is ready.
            startPolarTitle(
                user.id,
                body.data.threadId,
                resolved.model,
                finished,
                reasoningFor("fast", resolved.option)
            );
        },
        onError: () => "polar_failed"
    });
}
