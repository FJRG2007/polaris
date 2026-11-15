/**
 * Polar's native session engine: the agent loop a Polar Code session runs on
 * when it does not need an external CLI.
 *
 * One `NativeSession` per session. A turn sends the conversation to the model
 * with the tools declared but not executed by the SDK, so every call passes
 * through here: the permission gate (plan mode, the session's standing grants,
 * a prompt on the session page through the hook route), the tool itself, the
 * hook events Polaris reads for status, and the Claude-shaped transcript the
 * history rows are decoded from. The loop owns interruption (the turn's
 * signal), the model change (`setModel`), the permission mode (`setMode`) and
 * compaction (automatic above a budget, or `compact()` for /compact).
 *
 * The model is any AI SDK `LanguageModel`: in a session it is Polaris's own
 * compatible API, so the router picks keys and fallbacks for any provider; in
 * a test it is a scripted mock.
 */

import { randomUUID } from "node:crypto";
import { nativeSystemPrompt, type PromptEnvironment } from "@/lib/polar/native/prompt";
import { readDecision, type HookPayload, type HookSink } from "@/lib/polar/native/hooks";
import { generateText, tool, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import {
    NATIVE_TOOLS,
    sessionState,
    subagentTools,
    type NativeTool,
    type PermissionMode,
    type SessionState,
    type TaskInput,
    type ToolOutput
} from "@/lib/polar/native/tools";
import type { Workspace } from "@/lib/polar/native/workspace";
import { TranscriptWriter, type TranscriptBlock, type TranscriptBlockToolResult } from "@/lib/polar/native/transcript";

/** Model calls in one turn before it stops and says so. */
export const NATIVE_MAX_STEPS = 200;
/** A subagent's ceiling. */
export const SUBAGENT_MAX_STEPS = 60;
/** The conversation size, in characters of its JSON, that triggers compaction. */
export const COMPACT_AT_CHARS = 600_000;

const SUMMARY_PROMPT = [
    "Summarize this conversation so the work can continue from the summary alone.",
    "Keep: the user's requests and constraints in their own words, decisions made, files read and changed with what changed,",
    "commands run and their outcomes, errors and how they were fixed, the current task list, and exactly what remains to do next.",
    "Be specific: paths, names, commands. Do not add anything that did not happen."
].join(" ");

export interface NativeSessionOptions {
    readonly sessionId: string;
    readonly ws: Workspace;
    readonly model: LanguageModel;
    readonly modelName: string;
    readonly hooks: HookSink;
    /** Receives one JSONL line per transcript record. */
    readonly writeTranscript: (line: string) => void;
    readonly transcriptPath: string;
    readonly environment: Omit<PromptEnvironment, "cwd" | "model" | "planMode">;
    readonly mode?: PermissionMode;
    readonly maxSteps?: number;
    readonly compactAtChars?: number;
    readonly maxOutputTokens?: number;
    /** For a subagent: its tools, its sidechain transcript, no further Task. */
    readonly child?: { readonly tools: readonly NativeTool<never>[]; readonly agentId: string };
}

export interface TurnResult {
    readonly text: string;
    readonly interrupted: boolean;
    readonly stepLimit: boolean;
    readonly steps: number;
}

export class NativeSession {
    readonly state: SessionState;
    private messages: ModelMessage[] = [];
    private model: LanguageModel;
    private modelName: string;
    private readonly allowed = new Set<string>();
    private readonly transcript: TranscriptWriter;

    constructor(private readonly options: NativeSessionOptions) {
        this.state = sessionState(options.ws.root, options.mode ?? "default");
        this.model = options.model;
        this.modelName = options.modelName;
        this.transcript = new TranscriptWriter(
            options.sessionId,
            () => this.state.cwd,
            options.writeTranscript,
            Boolean(options.child)
        );
    }

    /** The conversation as the model reads it; for tests and resume. */
    history(): readonly ModelMessage[] {
        return this.messages;
    }

    setModel(model: LanguageModel, name: string): void {
        this.model = model;
        this.modelName = name;
    }

    setMode(mode: PermissionMode): void {
        this.state.mode = mode;
    }

    private tools(): readonly NativeTool<never>[] {
        return this.options.child?.tools ?? NATIVE_TOOLS;
    }

    private toolSet(): ToolSet {
        return Object.fromEntries(
            // Declared without `execute`: every call comes back here to be gated
            // and run. The schema's type is erased; `runCall` parses the input.
            this.tools().map((entry) => [
                entry.name,
                tool({ description: entry.description, inputSchema: entry.schema as never } as never)
            ])
        ) as ToolSet;
    }

    private base(event: string): HookPayload {
        return {
            hook_event_name: event,
            session_id: this.options.sessionId,
            transcript_path: this.options.transcriptPath,
            cwd: this.state.cwd,
            permission_mode: this.state.mode
        };
    }

    private systemPrompt(memory: PromptEnvironment["memory"]): string {
        return nativeSystemPrompt({
            ...this.options.environment,
            memory,
            cwd: this.state.cwd,
            model: this.modelName,
            planMode: this.state.mode === "plan"
        });
    }

    /** Tells Polaris the session is up and where its transcript is. */
    async start(): Promise<void> {
        await this.options.hooks.event({ ...this.base("SessionStart"), source: "startup" });
    }

    /** One user turn, to its end, an interruption, or the step ceiling. */
    async turn(prompt: string, signal: AbortSignal): Promise<TurnResult> {
        if (!this.options.child) await this.options.hooks.event({ ...this.base("UserPromptSubmit"), prompt });
        this.transcript.user(prompt);
        this.messages.push({ role: "user", content: prompt });
        const maxSteps = this.options.maxSteps ?? (this.options.child ? SUBAGENT_MAX_STEPS : NATIVE_MAX_STEPS);
        let text = "";
        let steps = 0;
        try {
            while (steps < maxSteps) {
                if (signal.aborted) throw signal.reason ?? new Error("aborted");
                if (JSON.stringify(this.messages).length > (this.options.compactAtChars ?? COMPACT_AT_CHARS)) {
                    await this.compact(signal, "auto");
                }
                steps++;
                const result = await generateText({
                    model: this.model,
                    system: this.systemPrompt(this.options.environment.memory),
                    messages: this.messages,
                    tools: this.toolSet(),
                    maxRetries: 0,
                    abortSignal: signal,
                    ...(this.options.maxOutputTokens ? { maxOutputTokens: this.options.maxOutputTokens } : {})
                });
                this.messages.push(...(result.response.messages as ModelMessage[]));
                const calls = result.toolCalls.map((call) => ({
                    id: call.toolCallId,
                    name: call.toolName,
                    input: (call as { input?: unknown }).input ?? {}
                }));
                const blocks: TranscriptBlock[] = [
                    ...(result.text.trim() ? [{ type: "text" as const, text: result.text }] : []),
                    ...calls.map((call) => ({ type: "tool_use" as const, id: call.id, name: call.name, input: call.input }))
                ];
                this.transcript.assistant(blocks, this.modelName);
                text = result.text;
                if (calls.length === 0) break;
                const outputs = await this.runCalls(calls, signal);
                this.transcript.toolResults(
                    outputs.map(
                        (output): TranscriptBlockToolResult => ({
                            type: "tool_result",
                            tool_use_id: output.id,
                            content: output.text,
                            ...(output.isError ? { is_error: true } : {})
                        })
                    )
                );
                this.messages.push({
                    role: "tool",
                    content: outputs.map((output) => ({
                        type: "tool-result" as const,
                        toolCallId: output.id,
                        toolName: output.name,
                        output: output.isError
                            ? { type: "error-text" as const, value: output.text }
                            : { type: "text" as const, value: output.text }
                    }))
                });
                if (steps >= maxSteps) {
                    text = `${text}\n\n[Stopped after ${maxSteps} steps.]`.trim();
                    await this.stop();
                    return { text, interrupted: false, stepLimit: true, steps };
                }
            }
        } catch (error) {
            if (!signal.aborted) throw error;
            this.closeOpenCalls();
            this.transcript.interrupted();
            this.messages.push({ role: "user", content: "[Request interrupted by user]" });
            await this.stop();
            return { text, interrupted: true, stepLimit: false, steps };
        }
        await this.stop();
        return { text, interrupted: false, stepLimit: false, steps };
    }

    private async stop(): Promise<void> {
        if (!this.options.child) await this.options.hooks.event({ ...this.base("Stop"), stop_hook_active: false });
    }

    /** After an interruption mid-call, every call the model made gets a result,
     *  or the next request is malformed for most providers. */
    private closeOpenCalls(): void {
        const last = this.messages.at(-1);
        if (!last || last.role !== "assistant" || typeof last.content === "string") return;
        const open = last.content.filter((part) => part.type === "tool-call");
        if (open.length === 0) return;
        this.messages.push({
            role: "tool",
            content: open.map((part) => ({
                type: "tool-result" as const,
                toolCallId: (part as { toolCallId: string }).toolCallId,
                toolName: (part as { toolName: string }).toolName,
                output: { type: "error-text" as const, value: "Interrupted by the user before it finished." }
            }))
        });
    }

    private async runCalls(
        calls: readonly { id: string; name: string; input: unknown }[],
        signal: AbortSignal
    ): Promise<(ToolOutput & { id: string; name: string })[]> {
        const byName = new Map(this.tools().map((entry) => [entry.name, entry]));
        // Read-only calls run together, as the model asked them in parallel;
        // anything that needs a yes or changes the checkout runs in order.
        const parallel = calls.every((call) => {
            const entry = byName.get(call.name);
            return entry && entry.gate === "none" && !entry.writes;
        });
        const one = async (call: { id: string; name: string; input: unknown }) => ({
            id: call.id,
            name: call.name,
            ...(await this.runCall(byName.get(call.name), call, signal))
        });
        if (parallel) return Promise.all(calls.map(one));
        const out: (ToolOutput & { id: string; name: string })[] = [];
        for (const call of calls) out.push(await one(call));
        return out;
    }

    private async runCall(
        entry: NativeTool<never> | undefined,
        call: { id: string; name: string; input: unknown },
        signal: AbortSignal
    ): Promise<ToolOutput> {
        if (!entry) return { text: `No such tool: ${call.name}`, isError: true };
        const parsed = (entry.schema as unknown as { safeParse: (value: unknown) => { success: boolean; data?: unknown; error?: { message: string } } }).safeParse(call.input);
        if (!parsed.success) return { text: `Invalid input for ${call.name}: ${parsed.error?.message ?? "rejected"}`, isError: true };
        const input = parsed.data as Record<string, unknown>;
        const pre = { ...this.base("PreToolUse"), tool_name: call.name, tool_input: input, tool_use_id: call.id };

        if (this.state.mode === "plan" && entry.writes) {
            return { text: "Plan mode: nothing may be changed yet. Finish the plan and present it with ExitPlanMode.", isError: true };
        }
        let answer: Record<string, unknown> | undefined;
        if (entry.gate === "ask") {
            const decision = readDecision(await this.options.hooks.decide(pre, signal));
            if (decision.behavior !== "allow") {
                return {
                    text:
                        decision.message ||
                        (call.name === "ExitPlanMode"
                            ? "The user did not approve the plan yet. Keep planning."
                            : "The user did not answer. Carry on with your best judgment."),
                    isError: decision.behavior === "none"
                };
            }
            answer = decision.updatedInput ?? input;
        } else {
            await this.options.hooks.event(pre);
            const refusal = await this.permit(entry, call.name, input, call.id, signal);
            if (refusal) return { text: refusal, isError: true };
        }
        let output: ToolOutput;
        try {
            output = await entry.run(input as never, {
                ws: this.options.ws,
                state: this.state,
                signal,
                answer,
                ...(this.options.child ? {} : { subagent: (task: TaskInput, inner: AbortSignal) => this.subagent(task, inner) })
            });
        } catch (error) {
            if (signal.aborted) throw error;
            output = { text: `${call.name} failed: ${(error as Error).message}`, isError: true };
        }
        await this.options.hooks.event({
            ...this.base(output.isError ? "PostToolUseFailure" : "PostToolUse"),
            tool_name: call.name,
            tool_input: input,
            tool_use_id: call.id,
            tool_response: output.text.slice(0, 2_000)
        });
        return output;
    }

    /** Null when the call may run, or the refusal the model reads. */
    private async permit(
        entry: NativeTool<never>,
        name: string,
        input: Record<string, unknown>,
        id: string,
        signal: AbortSignal
    ): Promise<string | null> {
        if (entry.gate === "none") return null;
        if (this.state.mode === "bypassPermissions") return null;
        if (this.state.mode === "acceptEdits" && entry.gate === "edit") return null;
        if (this.allowed.has(name)) return null;
        const decision = readDecision(
            await this.options.hooks.decide(
                {
                    ...this.base("PermissionRequest"),
                    tool_name: name,
                    tool_input: input,
                    tool_use_id: id,
                    permission_suggestions: [
                        { type: "addRules", rules: [{ toolName: name }], behavior: "allow", destination: "session" }
                    ]
                },
                signal
            )
        );
        if (decision.behavior === "allow") {
            if (decision.always) this.allowed.add(name);
            return null;
        }
        if (decision.behavior === "deny") return decision.message || "The user denied this.";
        return "Nobody answered the permission prompt in time, so this did not run. Ask again later or try another approach.";
    }

    private async subagent(task: TaskInput, signal: AbortSignal): Promise<string> {
        const agentId = randomUUID().replace(/-/g, "").slice(0, 16);
        const agentType = task.subagent_type ?? "general-purpose";
        await this.options.hooks.event({ ...this.base("SubagentStart"), agent_id: agentId, agent_type: agentType });
        const child = new NativeSession({
            ...this.options,
            mode: this.state.mode,
            child: { tools: subagentTools(task.subagent_type), agentId }
        });
        child.state.cwd = this.state.cwd;
        // The parent's standing grants hold for its children.
        for (const name of this.allowed) child.allowed.add(name);
        try {
            const result = await child.turn(
                `${task.prompt}\n\nWhen you are done, answer with a concise report of what you found or did; it is all the caller will see.`,
                signal
            );
            return result.text || "The subagent finished without a report.";
        } finally {
            await this.options.hooks.event({ ...this.base("SubagentStop"), agent_id: agentId, agent_type: agentType });
        }
    }

    /** Replaces the conversation with a summary the work can continue from. */
    async compact(signal: AbortSignal, trigger: "auto" | "manual" = "manual"): Promise<void> {
        if (this.messages.length === 0) return;
        await this.options.hooks.event({ ...this.base("PreCompact"), trigger, custom_instructions: "" });
        const result = await generateText({
            model: this.model,
            system: "You write faithful, specific summaries of coding sessions.",
            messages: [...this.messages, { role: "user", content: SUMMARY_PROMPT }],
            maxRetries: 0,
            abortSignal: signal
        });
        this.messages = [
            {
                role: "user",
                content: `This session continues from an earlier conversation, summarized here:\n\n${result.text.trim()}`
            }
        ];
        this.transcript.compacted();
    }
}
