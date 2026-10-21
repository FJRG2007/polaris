/**
 * POST /api/polar/chat - one turn with Polar, streamed.
 *
 * A route rather than a server action: an action is bound to the build that
 * served the page, and dies across an update in the middle of a conversation.
 *
 * Session-authenticated, body validated before anything is believed. The model
 * is one the person can spend a key on; the tools are Polaris's own MCP tools
 * run as the person, and any that can change something waits for an approval
 * in the chat (`toolApproval`). The page context arrives fenced as data, on
 * the question it was asked with (`withScreenNotes`), never in the system
 * prompt: the prompt stays byte-identical across screens and the tools across
 * screens of one app, so the provider's prompt cache keeps hitting. The model
 * is sent the core tools and the current app's (`tool-relevance.ts`);
 * `find_tools` brings in the rest.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import {
    convertToModelMessages,
    createUIMessageStream,
    createUIMessageStreamResponse,
    generateId,
    isStepCount,
    safeValidateUIMessages,
    streamText,
    type UIMessage,
    type UIMessageChunk
} from "ai";
import { polarAccessFor, polarCaller } from "@/lib/polar/access";
import { polarTools } from "@/lib/polar/tools";
import { connectorStandIns, polarConnectorTools } from "@/lib/polar/connectors/tools";
import { offWithServers } from "@/lib/polar/tool-servers";
import {
    FIND_TOOLS,
    READ_CURRENT_VIEW,
    activeToolNames,
    currentViewTool,
    findToolsTool,
    nextStep,
    usedInMessages
} from "@/lib/polar/tool-relevance";
import { POLAR_REFINES, polarSystemPrompt, refineLine } from "@/lib/polar/prompt";
import { polarVisualTools } from "@/lib/polar/visual-tool";
import { polarRepoTools } from "@/lib/polar/code-host-tools";
import { aboutRepository } from "@/lib/polar/code-host";
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
import { polarPreferences } from "@/lib/polar/preferences";
import { startPolarSuggestion } from "@/lib/polar/suggestions";
import {
    helperReasoning,
    helperMaySpend,
    polarHelperModel,
    recordHelperUsage,
    type PolarHelper
} from "@/lib/polar/helper-model";
import { fenceSummary, splitAtCompaction } from "@/lib/polar/compaction";
import { noteProviderFailure, turnSignals } from "@/lib/polar/automatic";
import { answerUsage, stepContext, polarLimitReached, recordPolarUsage } from "@/lib/polar/usage";
import { ensurePolarThread, polarThreadInstructions, savePolarMessages } from "@/lib/polar/threads";
import { polarModelOptions, reasoningFor, resolvePolarModel } from "@/lib/polar/models";
import {
    FAILURE_PART,
    classifyProviderFailure,
    decodePolarFailure,
    encodePolarFailure,
    failureLogLine,
    withoutFailures,
    type StoredFailure
} from "@/lib/polar/provider-failure";
import {
    modelChoiceSchema,
    pageContextSchema,
    storedScreen,
    withScreenNotes,
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
    web: z.boolean().default(true),
    /** Polar's tools the person switched off in its settings: not offered. */
    off: z.array(z.string().max(200)).max(2000).default([]),
    /** The MCP servers the person switched off as a whole (`tool-servers.ts`):
     *  none of their tools is offered, whatever each one's own switch says. */
    serversOff: z.array(z.string().max(300)).max(100).default([]),
    /** An answer asked again from its row with more detail or fewer words. */
    refine: z.enum(POLAR_REFINES).nullable().default(null),
    /** Whether the person left their connectors on for this turn. */
    connectors: z.boolean().default(true)
});

function refuse(code: string, status: number): NextResponse {
    return NextResponse.json({ error: code }, { status });
}

/**
 * A turn the model was never asked, answered as a message with why, so the
 * conversation keeps the question and the reason it went unanswered.
 */
function refusedTurn(
    messages: UIMessage[],
    failure: StoredFailure,
    save: (finished: UIMessage[]) => Promise<void>
): Response {
    return createUIMessageStreamResponse({
        stream: createUIMessageStream({
            originalMessages: messages,
            generateId,
            execute: ({ writer }) => {
                writer.write({ type: "start" });
                writer.write({ type: FAILURE_PART, data: failure });
                writer.write({ type: "finish" });
            },
            onFinish: ({ messages: finished }) => save(finished)
        })
    });
}

/**
 * A provider's refusal mid-answer is also written into the answer, just before
 * the stream's error, so the stored message says why it stopped.
 */
function failureIntoAnswer(): TransformStream<UIMessageChunk, UIMessageChunk> {
    return new TransformStream({
        transform(chunk, controller) {
            if (chunk.type === "error") {
                const failure = decodePolarFailure(chunk.errorText);
                if (failure) controller.enqueue({ type: FAILURE_PART, data: failure });
            }
            controller.enqueue(chunk);
        }
    });
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

    const access = await polarAccessFor(user.id);
    const [toolset, connectorSet] = await Promise.all([
        polarTools(user),
        polarConnectorTools(user, access)
    ]);
    // Tools the person switched off in Polar's settings: never offered, and
    // never turned up by find_tools either.
    const off = offWithServers(body.data.off, body.data.serversOff, {
        ...Object.fromEntries(Object.keys(toolset.tools).map((name) => [name, {}])),
        ...connectorSet.described
    });
    const catalog = toolset.catalog.filter((entry) => !off.has(entry.name));
    // Known to the check even while memory is off, so an older turn that used
    // them still reads as valid.
    const memoryTools = polarMemoryTools(user.id, body.data.threadId);
    const screenTools = {
        ...currentViewTool(body.data.context, async (name, input) =>
            off.has(name) ? null : toolset.call(name, input)
        ),
        ...findToolsTool(catalog)
    };
    const visualTools = polarVisualTools();
    const repoTools = polarRepoTools(user.id);
    const checked = await safeValidateUIMessages({
        messages: body.data.messages,
        tools: {
            ...toolset.tools,
            ...screenTools,
            ...memoryTools,
            ...visualTools,
            ...repoTools,
            ...NATIVE_SEARCH_STAND_INS,
            ...polarWebTools("", ""),
            ...connectorSet.tools,
            ...connectorStandIns(body.data.messages, connectorSet.tools)
        } as never
    });
    if (!checked.success) return refuse("invalid", 400);
    const messages = (checked.data as UIMessage[]).map((message, index, list) =>
        // The newest question carries the screen it was asked on, stored with
        // it; older ones keep what they were saved with.
        index === list.length - 1 && message.role === "user"
            ? {
                  ...message,
                  metadata: {
                      ...((message.metadata as object | undefined) ?? {}),
                      screen: storedScreen(body.data.context)
                  }
              }
            : message
    );

    // A thread whose model has since been retired by its provider falls back to
    // the first model this person can use, and the answer says so.
    let choice: ModelChoice = body.data.choice;
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
    // Reading a repository is reading the web, under the same switch. Always
    // registered; sent while the page shared or the conversation names one.
    const repoOffered = web && aboutRepository(body.data.context?.site?.url, messages);
    const tools = {
        ...screenTools,
        ...Object.fromEntries(Object.entries(toolset.tools).filter(([name]) => !off.has(name))),
        ...(remembers ? memoryTools : {}),
        ...visualTools,
        ...webTools,
        ...(web ? repoTools : {}),
        ...(body.data.connectors
            ? Object.fromEntries(
                  Object.entries(connectorSet.tools).filter(([name]) => !off.has(name))
              )
            : {})
    };
    // What the model is sent: the core and the current app's tools, and any
    // this conversation already reached for. Every one stays registered, so an
    // approval or an older turn naming one still resolves.
    const always = [
        READ_CURRENT_VIEW,
        FIND_TOOLS,
        ...Object.keys(visualTools),
        ...Object.keys(remembers ? memoryTools : {}),
        ...Object.keys(webTools),
        ...(repoOffered ? Object.keys(repoTools) : []),
        // A connector is one the person added on purpose: its tools are always sent.
        ...(body.data.connectors
            ? Object.keys(connectorSet.tools).filter((name) => !off.has(name))
            : [])
    ];
    const used = usedInMessages(messages as never);
    const activeFor = (found: ReadonlySet<string>) =>
        activeToolNames(
            catalog,
            body.data.context?.app,
            always,
            new Set([...used, ...found])
        ) as (keyof typeof tools & string)[];

    const parentFor = (index: number, list: readonly UIMessage[]): string | null =>
        index === list.length - 1 && list[index]?.role === "user"
            ? body.data.parentId
            : (list[index - 1]?.id ?? null);
    const save = async (finished: UIMessage[]): Promise<void> => {
        try {
            await savePolarMessages(user.id, body.data.threadId, finished, (index) =>
                parentFor(index, finished)
            );
        } catch (error) {
            console.error("polar: could not save the turn", error);
        }
    };

    // The administrator's token ceilings bound the key this Polaris shares; a
    // person's own key is theirs to spend.
    if (resolved.credential.source === "instance") {
        const hit = await polarLimitReached(user.id);
        if (hit) return refusedTurn(messages, { code: "usage_limit", ...hit }, save);
    }

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
    if (unreadable[0] !== undefined) {
        return refusedTurn(messages, { code: "file_unreadable", name: unreadable[0] }, save);
    }

    const startedAt = Date.now();
    let spent: ReturnType<typeof answerUsage> | undefined;
    // The newest step's own counts: what the conversation measures now, for
    // the context bar. `totalUsage` sums every step and overstates it.
    let lastStep: { inputTokens: number | undefined; outputTokens: number | undefined } | undefined;
    const result = streamText({
        model: resolved.model,
        // One breakpoint after the tools and the system prompt: Anthropic caches
        // that prefix (docs.anthropic.com prompt caching); OpenAI and Gemini
        // cache a byte-identical prefix on their own.
        system: {
            role: "system",
            content: [
                polarSystemPrompt(user.name, instructions, memories, web),
                fenceSummary(compacted.summary),
                // Only on a turn asked again from an answer's row: that turn's
                // prefix is not cached, every other one is.
                refineLine(body.data.refine)
            ]
                .filter(Boolean)
                .join("\n\n"),
            providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } }
        },
        messages: await convertToModelMessages(withScreenNotes(withoutFailures(sendable))),
        tools,
        activeTools: activeFor(new Set()),
        // A tool find_tools turned up is sent from the next step on, and the
        // last step has to answer.
        prepareStep: ({ stepNumber, steps }) =>
            nextStep(stepNumber, STEP_MAX, steps as never, activeFor),
        toolApproval: {
            ...toolset.approval,
            ...(body.data.connectors ? connectorSet.approval : {}),
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

    const answer = result.toUIMessageStream({
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

    const stream = createUIMessageStream({
        originalMessages: messages,
        // The answer's id is decided here and sent with its first chunk, so the
        // screen and the stored row share it. Without it the row is saved under
        // an empty id, which every later answer collides with and is dropped.
        // A turn that continues an answer keeps that answer's id.
        generateId,
        execute: ({ writer }) => writer.merge(answer.pipeThrough(failureIntoAnswer())),
        onFinish: async ({ messages: finished, responseMessage }) => {
            await save(finished);
            if (spent) {
                // Whether the stable prefix is being served from the cache.
                console.info(
                    `polar: turn input ${spent.inputTokens} tokens, ${spent.cachedTokens ?? "unreported"} cached (${resolved.option.provider})`
                );
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
            // The small jobs run behind the reply on the helper model the
            // person picked (`helper-model.ts`): a new thread's title once the
            // first answer is in, and the suggested next message after every
            // answer unless it is switched off. The screen asks for each when
            // it is ready; nothing here holds the stream open.
            const preferences = polarPreferences(user.id).catch(() => null);
            const helper: Promise<PolarHelper | null> = preferences
                .then((settings) =>
                    polarHelperModel(user.id, resolved, settings?.helperModel ?? null, access)
                )
                .catch(() => null);
            // Switched off, the suggestion's model is none and no call is made.
            startPolarSuggestion(
                user.id,
                body.data.threadId,
                finished,
                preferences.then((settings) => (settings?.suggestions === false ? null : helper))
            );
            if (temporary) return;
            startPolarTitle(
                user.id,
                body.data.threadId,
                helper.then(async (side) => {
                    const job: PolarHelper =
                        side && (await helperMaySpend(user.id, side))
                            ? side
                            : { resolved, source: "chat" };
                    return {
                        model: job.resolved.model,
                        reasoning: helperReasoning(job),
                        spent: (usage) => recordHelperUsage(user.id, body.data.threadId, job, usage)
                    };
                }),
                finished
            );
        }
    });
    return createUIMessageStreamResponse({ stream });
}
