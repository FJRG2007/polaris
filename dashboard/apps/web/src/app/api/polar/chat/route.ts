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
    generateId,
    isStepCount,
    safeValidateUIMessages,
    streamText,
    type UIMessage
} from "ai";
import { polarAccessFor, polarCaller } from "@/lib/polar/access";
import { polarTools } from "@/lib/polar/tools";
import { polarSystemPrompt } from "@/lib/polar/prompt";
import {
    NATIVE_SEARCH_STAND_INS,
    WEB_APPROVAL,
    polarWebTools,
    withoutPastProviderSearches
} from "@/lib/polar/web";
import { readCappedBody } from "@/lib/request-body";
import { rateLimit } from "@/lib/rate-limit-service";
import { inlinePolarFiles } from "@/lib/polar/attachments";
import {
    MEMORY_APPROVAL,
    polarMemoryEnabled,
    polarMemoryPrompt,
    polarMemoryTools
} from "@/lib/polar/memory";
import { startPolarTitle } from "@/lib/polar/titles";
import { fenceSummary, splitAtCompaction } from "@/lib/polar/compaction";
import { noteProviderFailure, turnSignals } from "@/lib/polar/automatic";
import { answerUsage, stepContext, polarLimitReached, recordPolarUsage } from "@/lib/polar/usage";
import { ensurePolarThread, polarThreadInstructions, savePolarMessages } from "@/lib/polar/threads";
import { polarModelOptions, reasoningFor, resolvePolarModel } from "@/lib/polar/models";
import {
    classifyProviderFailure,
    encodePolarFailure,
    failureLogLine
} from "@/lib/polar/provider-failure";
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
    projectId: z.string().uuid().nullable().default(null),
    /** A new thread made temporary: not listed, no memory, deleted on leave. */
    temporary: z.boolean().default(false),
    /** False for a turn sent on a command's own model: the thread keeps the
     *  model it was on, so the next message goes back to it. */
    remember: z.boolean().default(true),
    /** Whether the person left web search on for this turn. */
    web: z.boolean().default(true)
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
    const user = await polarCaller();
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
    // Known to the check even while memory is off, so an older turn that used
    // them still reads as valid.
    const memoryTools = polarMemoryTools(user.id, body.data.threadId);
    const checked = await safeValidateUIMessages({
        messages: body.data.messages,
        tools: {
            ...toolset.tools,
            ...memoryTools,
            ...NATIVE_SEARCH_STAND_INS,
            ...polarWebTools("", "")
        } as never
    });
    if (!checked.success) return refuse("invalid", 400);
    const messages = checked.data as UIMessage[];

    // A thread whose model has since been retired by its provider falls back to
    // the first model this person can use, and the answer says so.
    let choice: ModelChoice = body.data.choice;
    const access = await polarAccessFor(user.id);
    const signals = turnSignals(messages);
    let resolved = await resolvePolarModel(user.id, choice, signals, access);
    let fellBackFrom: string | null = null;
    if (resolved === "unknown_model") {
        const first = (await polarModelOptions(user.id, access))[0]?.models[0];
        if (first) {
            fellBackFrom = choice.model;
            choice = { ...choice, provider: first.provider, model: first.model, payer: null };
            resolved = await resolvePolarModel(user.id, choice, signals, access);
        }
    }
    if (typeof resolved === "string") return refuse(resolved, 409);
    // The administrator's token ceilings bound the key this Polaris shares; a
    // person's own key is theirs to spend.
    if (resolved.credential.source === "instance") {
        const hit = await polarLimitReached(user.id);
        if (hit) return NextResponse.json({ error: "usage_limit", ...hit }, { status: 429 });
    }

    const owned = await ensurePolarThread(
        user.id,
        body.data.threadId,
        firstText(messages[0]),
        body.data.remember ? choice : null,
        body.data.projectId,
        body.data.temporary
    );
    if (!owned) return refuse("not_found", 404);
    // The stored kind decides, whatever this request said.
    const temporary = owned.temporary;
    const [instructions, remembers] = await Promise.all([
        polarThreadInstructions(user.id, body.data.threadId),
        temporary ? Promise.resolve(false) : polarMemoryEnabled(user.id)
    ]);
    const memories = remembers ? await polarMemoryPrompt(user.id) : "";
    // The web is the administrator's to allow and the person's to switch off
    // for a turn; either one off and the tools are simply not offered.
    const web = access.web && body.data.web;
    const webTools = web ? polarWebTools(resolved.credential.provider, resolved.option.model) : {};
    const tools = {
        ...toolset.tools,
        ...(remembers ? memoryTools : {}),
        ...webTools
    };

    const parentFor = (index: number, list: readonly UIMessage[]): string | null =>
        index === list.length - 1 && list[index]?.role === "user"
            ? body.data.parentId
            : (list[index - 1]?.id ?? null);

    // A file the model cannot read is sent as its text; one with no text to
    // take out stops the turn with its name instead of being dropped unseen.
    const unreadable: string[] = [];
    // After a compaction marker the model reads its summary and what follows
    // it, never the history it replaced (`compaction.ts`).
    const compacted = splitAtCompaction(messages);
    const sendable = await inlinePolarFiles(
        user.id,
        withoutPastProviderSearches(compacted.messages),
        resolved.option,
        unreadable
    );
    if (unreadable.length > 0) {
        return NextResponse.json(
            { error: "file_unreadable", name: unreadable[0] },
            { status: 422 }
        );
    }

    const startedAt = Date.now();
    let spent: ReturnType<typeof answerUsage> | undefined;
    // The newest step's own counts: what the conversation measures now, for
    // the context bar. `totalUsage` sums every step and overstates it.
    let lastStep: { inputTokens: number | undefined; outputTokens: number | undefined } | undefined;
    const result = streamText({
        model: resolved.model,
        system: [
            polarSystemPrompt(
                user.name,
                fencePageContext(body.data.context),
                instructions,
                memories,
                web
            ),
            fenceSummary(compacted.summary)
        ]
            .filter(Boolean)
            .join("\n\n"),
        messages: await convertToModelMessages(sendable),
        tools,
        toolApproval: {
            ...toolset.approval,
            ...(remembers ? MEMORY_APPROVAL : {}),
            ...(web ? WEB_APPROVAL : {})
        },
        stopWhen: isStepCount(STEP_MAX),
        // Automatic sends a quick question at the lowest effort.
        reasoning: reasoningFor(
            resolved.automatic === "fast" ? "fast" : choice.intelligence,
            resolved.option
        ),
        abortSignal: request.signal
    });

    return result.toUIMessageStreamResponse({
        originalMessages: messages,
        // The answer's id is decided here and sent with its first chunk, so the
        // screen and the stored row share it. Without it the row is saved under
        // an empty id, which every later answer collides with and is dropped.
        // A turn that continues an answer keeps that answer's id.
        generateMessageId: generateId,
        sendReasoning: true,
        // A provider's own search reports what it read as sources.
        sendSources: true,
        messageMetadata: ({ part }) => {
            if (part.type === "finish-step") lastStep = part.usage;
            return part.type === "start"
                ? {
                      model: resolved.option.name,
                      provider: resolved.option.providerName,
                      payer: resolved.credential.source,
                      automatic: !!resolved.automatic,
                      fellBackFrom
                  }
                : part.type === "finish"
                  ? // How long the turn worked, for the line its steps fold
                    // into, and what it spent, for the line under the answer.
                    {
                        workedMs: Date.now() - startedAt,
                        usage: (spent = {
                            ...answerUsage(part.totalUsage, resolved.option),
                            ...stepContext(lastStep)
                        })
                    }
                  : undefined;
        },
        onFinish: async ({ messages: finished, responseMessage }) => {
            try {
                await savePolarMessages(user.id, body.data.threadId, finished, (index) =>
                    parentFor(index, finished)
                );
            } catch (error) {
                console.error("polar: could not save the turn", error);
            }
            if (spent) {
                try {
                    await recordPolarUsage({
                        userId: user.id,
                        threadId: body.data.threadId,
                        messageId: responseMessage?.id ?? null,
                        provider: resolved.option.provider,
                        model: resolved.option.model,
                        payer: resolved.credential.source === "instance" ? "instance" : "own",
                        usage: spent
                    });
                } catch (error) {
                    console.error("polar: could not record the turn's usage", error);
                }
            }
            // A new thread is named by its model once the first answer is in,
            // behind the reply; the screen asks for the title when it is ready.
            if (temporary) return;
            startPolarTitle(
                user.id,
                body.data.threadId,
                resolved.model,
                finished,
                reasoningFor("fast", resolved.option)
            );
        },
        // The provider's refusal is classified and named, never forwarded: its
        // body is the provider's own words about the account it belongs to.
        onError: (error) => {
            // Automatic tries this provider last for a few minutes.
            noteProviderFailure(user.id, resolved.option.provider);
            const failure = classifyProviderFailure(error);
            console.warn(failureLogLine("a turn", resolved.option.providerName, failure));
            return encodePolarFailure({
                code: "provider",
                kind: failure.kind,
                provider: resolved.option.providerName,
                slug: resolved.option.provider,
                payer: resolved.credential.source
            });
        }
    });
}
