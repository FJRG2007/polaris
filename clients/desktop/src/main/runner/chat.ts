/**
 * Polar Chat turns on the person's own Claude subscription (`chat.turn`),
 * run by the managed Claude Code through the Claude Agent SDK.
 *
 * `claude-chat.ts` holds the options and the message mapping; this drives one
 * turn: prepare `claude` and the SDK, `query()`, send each mapped event as a
 * `chat.event` with an increasing `seq`, wait on the person for every tool
 * call (`approval` -> `chat.approval`), and stop on `chat.cancel`.
 *
 * The SDK is handed in (`loadSdk`), so a turn is tested with a fake one.
 */

import { randomUUID } from "node:crypto";
import type { RunnerFrame, ServerFrame } from "./connection";
import { claudeChatOptions, claudeFailureCode, mapClaudeMessage, type ChatEvent } from "../claude-chat";

/** The part of `@anthropic-ai/claude-agent-sdk` a turn uses. */
export interface ClaudeSdk {
    query(input: { prompt: string; options: Record<string, unknown>; }): AsyncIterable<unknown> & { interrupt?: () => Promise<void>; };
}

type PermissionResult = { behavior: "allow"; updatedInput: Record<string, unknown>; } | { behavior: "deny"; message: string; };

export interface ChatDeps {
    readonly send: (frame: RunnerFrame) => boolean;
    /** Prepare `claude` and the SDK; answers the environment, `claude`'s path
     *  and the loaded SDK, or null when it could not. */
    readonly prepare: () => Promise<{ env: Record<string, string>; claudePath: string; sdk: ClaudeSdk; } | null>;
    /** A folder of its own for chat turns, with nothing of the person's in it. */
    readonly cwd: string;
    readonly log?: (message: string) => void;
}

type ChatTurn = ServerFrame & { type: "chat.turn"; };

interface Running {
    readonly abort: AbortController;
    readonly approvals: Map<string, (allow: boolean) => void>;
    seq: number;
    cancelled: boolean;
}

/** Longest text one event may carry (`runnerChatEventSchema`). */
const TEXT_MAX = 64_000;

/** The conversation as the one prompt a turn takes: the SDK reads only the
 *  person's side, so earlier answers are quoted as context before the newest
 *  message. Pure, for the tests. */
export function chatPrompt(messages: ChatTurn["messages"]): string {
    const last = messages[messages.length - 1]!;
    if (messages.length === 1) return last.text;
    const earlier = messages
        .slice(0, -1)
        .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.text}`)
        .join("\n\n");
    return `<conversation>\n${earlier}\n</conversation>\n\n${last.text}`;
}

/** An event cut to what the protocol accepts. */
function bounded(event: ChatEvent): ChatEvent {
    if ((event.kind === "text" || event.kind === "reasoning") && event.text.length > TEXT_MAX) return { ...event, text: event.text.slice(0, TEXT_MAX) };
    return event;
}

export class ChatHost {
    readonly #turns = new Map<string, Running>();

    constructor(private readonly deps: ChatDeps) {}

    handle(frame: ServerFrame): boolean {
        if (frame.type === "chat.turn") {
            if (!this.#turns.has(frame.turnId)) void this.#run(frame);
            return true;
        }
        if (frame.type === "chat.cancel") {
            const turn = this.#turns.get(frame.turnId);
            if (turn) {
                turn.cancelled = true;
                for (const resolve of turn.approvals.values()) resolve(false);
                turn.abort.abort();
            }
            return true;
        }
        if (frame.type === "chat.approval") {
            const turn = this.#turns.get(frame.turnId);
            const resolve = turn?.approvals.get(frame.approvalId);
            if (turn && resolve) {
                turn.approvals.delete(frame.approvalId);
                resolve(frame.allow);
            }
            return true;
        }
        return false;
    }

    cancelAll(): void {
        for (const turnId of this.#turns.keys()) this.handle({ v: 1, type: "chat.cancel", turnId });
    }

    #emit(turnId: string, turn: Running, event: ChatEvent): void {
        this.deps.send({ type: "chat.event", turnId, seq: turn.seq++, event: bounded(event) });
    }

    async #run(frame: ChatTurn): Promise<void> {
        const turn: Running = { abort: new AbortController(), approvals: new Map(), seq: 0, cancelled: false };
        this.#turns.set(frame.turnId, turn);
        const emit = (event: ChatEvent) => this.#emit(frame.turnId, turn, event);
        try {
            const ready = await this.deps.prepare();
            if (turn.cancelled) return emit({ kind: "finish", reason: "cancelled" });
            if (!ready) return emit({ kind: "error", code: "not-installed" });
            const options = {
                ...claudeChatOptions({
                    claudePath: ready.claudePath,
                    cwd: this.deps.cwd,
                    model: frame.model,
                    system: frame.system,
                    effort: frame.effort,
                    mcp: frame.mcp,
                    env: ready.env
                }),
                abortController: turn.abort,
                canUseTool: (name: string, input: Record<string, unknown>, context?: { toolUseID?: string; }): Promise<PermissionResult> =>
                    new Promise((resolve) => {
                        if (turn.cancelled) return resolve({ behavior: "deny", message: "The turn was cancelled." });
                        const approvalId = randomUUID();
                        turn.approvals.set(approvalId, (allow) =>
                            resolve(allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "The person declined this tool call." })
                        );
                        emit({ kind: "approval", approvalId, callId: (context?.toolUseID ?? approvalId).slice(0, 200), name: name.slice(0, 200), input });
                    })
            };
            const state = { streamed: false };
            let finished = false;
            for await (const message of ready.sdk.query({ prompt: chatPrompt(frame.messages), options })) {
                for (const event of mapClaudeMessage(message as Parameters<typeof mapClaudeMessage>[0], state)) {
                    if (event.kind === "finish" || event.kind === "error") finished = true;
                    emit(event);
                }
            }
            if (!finished) emit(turn.cancelled ? { kind: "finish", reason: "cancelled" } : { kind: "finish", reason: "stop" });
        } catch (error) {
            if (turn.cancelled) emit({ kind: "finish", reason: "cancelled" });
            else {
                this.deps.log?.(`runner: chat turn failed: ${error instanceof Error ? error.message : String(error)}`);
                emit({ kind: "error", code: claudeFailureCode(error) });
            }
        } finally {
            this.#turns.delete(frame.turnId);
        }
    }
}
