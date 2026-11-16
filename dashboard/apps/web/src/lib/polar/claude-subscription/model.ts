/**
 * "Claude (your subscription)" as an AI SDK language model, so a turn on it
 * runs through the same `streamText`, router plan, approval card and saved
 * history as any other model.
 *
 * Claude Code on the person's computer runs the whole agent loop itself,
 * Polaris's tools included (through `/api/mcp`, on a token minted for this
 * turn). Its tool calls therefore reach the stream as provider-executed,
 * dynamic calls with their results; an approval it waits on becomes the
 * stream's approval request and ends the stream, and the answer the screen
 * sends back resumes the same runner turn (`turns.ts`).
 *
 * Server-only.
 */

import { randomUUID } from "node:crypto";
import type * as core from "@polaris/core";
import type { LanguageModelMiddleware } from "ai";
import {
    CLAUDE_SUBSCRIPTION_PROVIDER,
    resumePoint,
    runSubscriptionTurn,
    subscriptionRunnerFor
} from "@/lib/polar/claude-subscription/turns";
import { mintTurnToken } from "@/lib/polar/claude-subscription/mcp-token";
import { SUBSCRIPTION_FAILURES, type SubscriptionFailure } from "@/lib/polar/provider-failure";

type Model = Parameters<NonNullable<LanguageModelMiddleware["wrapStream"]>>[0]["model"];
type CallOptions = Parameters<Model["doStream"]>[0];
type Prompt = CallOptions["prompt"];
type StreamPart = Awaited<ReturnType<Model["doStream"]>>["stream"] extends ReadableStream<infer P> ? P : never;

/** Why a subscription turn did not answer, as the reader's own words name it. */
export class SubscriptionTurnError extends Error {
    constructor(readonly reason: SubscriptionFailure) {
        super(`claude subscription: ${reason}`);
        this.name = "SubscriptionTurnError";
    }
}

/** The subscription's reason behind an error, looking through causes the
 *  router or the SDK wrapped it in; null for any other error. */
export function subscriptionFailureOf(error: unknown): SubscriptionFailure | null {
    for (let at: unknown = error, depth = 0; at && depth < 5; depth++) {
        const reason = (at as { name?: unknown; reason?: unknown }).name === "SubscriptionTurnError" ? (at as { reason?: unknown }).reason : null;
        if (typeof reason === "string" && (SUBSCRIPTION_FAILURES as readonly string[]).includes(reason)) return reason as SubscriptionFailure;
        at = (at as { cause?: unknown }).cause;
    }
    return null;
}

const APPROVAL_ID = /^cs1\.([0-9a-f-]{36})\.(\d{1,9})\.([0-9a-f-]{36})$/;

/** The approval id the stream carries: the runner's own, with the turn and
 *  the position it resumes from, so any node can carry the turn on. */
export function approvalIdFor(turnId: string, seq: number, approvalId: string): string {
    return `cs1.${turnId}.${seq}.${approvalId}`;
}

export function readApprovalId(id: string): { turnId: string; seq: number; approvalId: string } | null {
    const match = APPROVAL_ID.exec(id);
    return match ? { turnId: match[1]!, seq: Number(match[2]), approvalId: match[3]! } : null;
}

type Resume = { turnId: string; seq: number; answers: { approvalId: string; allow: boolean }[] };

/**
 * What the prompt asks of the runner. A prompt that ends in the person's
 * answers to this subscription's approvals resumes that turn; anything else
 * starts one, with the conversation as plain text (Claude Code keeps no
 * history of its own between turns). Pure.
 */
export function readPrompt(prompt: Prompt): {
    system: string;
    messages: { role: "user" | "assistant"; text: string }[];
    resume: Resume | null;
    calls: Set<string>;
} {
    const system: string[] = [];
    const messages: { role: "user" | "assistant"; text: string }[] = [];
    const calls = new Set<string>();
    for (const message of prompt) {
        if (message.role === "system") {
            system.push(message.content);
            continue;
        }
        if (message.role === "tool") continue;
        const text = message.content
            .map((part) => {
                if (part.type === "tool-call") calls.add(part.toolCallId);
                return part.type === "text" ? part.text : "";
            })
            .filter(Boolean)
            .join("\n");
        if (text) messages.push({ role: message.role, text });
    }
    const last = prompt.at(-1);
    let resume: Resume | null = null;
    if (last?.role === "tool") {
        for (const part of last.content) {
            if (part.type !== "tool-approval-response") continue;
            const read = readApprovalId(part.approvalId);
            if (!read || (resume && read.turnId !== resume.turnId)) return { system: system.join("\n\n"), messages, resume: null, calls };
            resume ??= { turnId: read.turnId, seq: read.seq, answers: [] };
            resume.seq = Math.max(resume.seq, read.seq);
            resume.answers.push({ approvalId: read.approvalId, allow: part.approved });
        }
    }
    return { system: system.join("\n\n"), messages, resume, calls };
}

const NO_USAGE = {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined }
};

/** The runner's events as stream parts, in order. `seq` is where the turn
 *  resumes after the event just mapped, for an approval. Pure but for ids. */
export function createEventMapper(turnId: string, calls: Set<string>) {
    let open: { kind: "text" | "reasoning"; id: string } | null = null;
    const names = new Map<string, string>();

    function close(): StreamPart[] {
        if (!open) return [];
        const part = { type: open.kind === "text" ? "text-end" : "reasoning-end", id: open.id } as StreamPart;
        open = null;
        return [part];
    }

    function call(callId: string, name: string, input: Record<string, unknown>): StreamPart[] {
        names.set(callId, name);
        if (calls.has(callId)) return [];
        calls.add(callId);
        return [{ type: "tool-call", toolCallId: callId, toolName: name, input: JSON.stringify(input), providerExecuted: true, dynamic: true }];
    }

    return function map(event: core.RunnerChatEvent, seq: number): StreamPart[] {
        switch (event.kind) {
            case "text":
            case "reasoning": {
                const parts: StreamPart[] = [];
                if (open?.kind !== event.kind) {
                    parts.push(...close());
                    open = { kind: event.kind, id: randomUUID() };
                    parts.push({ type: event.kind === "text" ? "text-start" : "reasoning-start", id: open.id } as StreamPart);
                }
                parts.push({ type: event.kind === "text" ? "text-delta" : "reasoning-delta", id: open.id, delta: event.text } as StreamPart);
                return parts;
            }
            case "tool-call":
                return [...close(), ...call(event.callId, event.name, event.input)];
            case "tool-result":
                return [
                    ...close(),
                    {
                        type: "tool-result",
                        toolCallId: event.callId,
                        toolName: names.get(event.callId) ?? "tool",
                        result: event.output,
                        isError: event.isError
                    }
                ];
            case "approval":
                return [
                    ...close(),
                    ...call(event.callId, event.name, event.input),
                    { type: "tool-approval-request", approvalId: approvalIdFor(turnId, seq, event.approvalId), toolCallId: event.callId },
                    { type: "finish", usage: NO_USAGE, finishReason: { unified: "tool-calls", raw: "approval" } }
                ];
            case "finish":
                return [
                    ...close(),
                    {
                        type: "finish",
                        usage: event.usage
                            ? {
                                  inputTokens: { total: event.usage.input, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
                                  outputTokens: { total: event.usage.output, text: undefined, reasoning: undefined }
                              }
                            : NO_USAGE,
                        finishReason: { unified: event.reason === "cancelled" ? "other" : event.reason, raw: event.reason }
                    }
                ];
            case "error":
                return [
                    ...close(),
                    { type: "error", error: new SubscriptionTurnError(event.code) },
                    { type: "finish", usage: NO_USAGE, finishReason: { unified: "error", raw: event.code } }
                ];
        }
    };
}

/** The MCP endpoint and this turn's token for it. */
async function turnMcp(userId: string, turnId: string): Promise<{ url: string; token: string }> {
    // Loaded here: the domain reader pulls in the whole auth stack.
    const { appBaseUrl } = await import("@/lib/domain-service");
    const base = (await appBaseUrl()).replace(/\/+$/, "");
    return { url: `${base}/api/mcp`, token: mintTurnToken(userId, turnId) };
}

/** Claude on the person's subscription, as `model` (an alias Claude Code
 *  takes: `opus`, `sonnet`, `haiku`). */
export function subscriptionLanguageModel(userId: string, model: string): Model {
    async function doStream(options: CallOptions): Promise<Awaited<ReturnType<Model["doStream"]>>> {
        const runnerId = await subscriptionRunnerFor(userId);
        if (!runnerId) throw new SubscriptionTurnError("offline");
        const read = readPrompt(options.prompt);
        const turnId = read.resume?.turnId ?? randomUUID();
        const events = runSubscriptionTurn({
            userId,
            runnerId,
            turnId,
            model,
            system: read.system,
            messages: read.messages,
            effort: null,
            mcp: read.resume ? null : await turnMcp(userId, turnId),
            signal: options.abortSignal,
            ...(read.resume ? { resume: { seq: read.resume.seq, answers: read.resume.answers } } : {})
        });
        // A turn that fails before it says anything is thrown, so the router
        // can hand it to the next step of the plan.
        const first = await events.next();
        if (first.done) throw new SubscriptionTurnError("failed");
        if (first.value.kind === "error") throw new SubscriptionTurnError(first.value.code);
        const map = createEventMapper(turnId, read.calls);
        let pending: core.RunnerChatEvent | null = first.value;
        const stream = new ReadableStream<StreamPart>({
            start(controller) {
                controller.enqueue({ type: "stream-start", warnings: [] });
                controller.enqueue({ type: "response-metadata", modelId: model });
            },
            async pull(controller) {
                const next = pending ? { done: false as const, value: pending } : await events.next();
                pending = null;
                if (next.done) {
                    controller.close();
                    return;
                }
                const seq = resumePoint(turnId) ?? 0;
                for (const part of map(next.value, seq)) controller.enqueue(part);
                if (next.value.kind === "finish" || next.value.kind === "error" || next.value.kind === "approval") controller.close();
            },
            async cancel() {
                await events.return(undefined);
            }
        });
        return { stream };
    }

    return {
        specificationVersion: "v4",
        provider: CLAUDE_SUBSCRIPTION_PROVIDER,
        modelId: model,
        supportedUrls: {},
        doStream,
        async doGenerate(options) {
            const { stream } = await doStream(options);
            let text = "";
            let finish: Extract<StreamPart, { type: "finish" }> | null = null;
            const reader = stream.getReader();
            for (let read = await reader.read(); !read.done; read = await reader.read()) {
                const part = read.value;
                if (part.type === "text-delta") text += part.delta;
                else if (part.type === "finish") finish = part;
                else if (part.type === "error") throw part.error;
            }
            return {
                content: text ? [{ type: "text", text }] : [],
                finishReason: finish?.finishReason ?? { unified: "other", raw: undefined },
                usage: finish?.usage ?? NO_USAGE,
                warnings: []
            };
        }
    };
}
