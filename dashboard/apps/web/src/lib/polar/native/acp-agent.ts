/**
 * `polaris-agent acp`: Polar as an Agent Client Protocol agent, so an editor
 * (Zed, a JetBrains IDE, any ACP client) runs it as the subprocess it talks
 * JSON-RPC to over standard input and output - the way `opencode acp` does
 * (opencode.ai/docs/acp: "starts OpenCode as an ACP-compatible subprocess
 * that communicates with your editor over JSON-RPC via stdio").
 *
 * Each ACP session is one `NativeSession`, the same engine a Polar Code
 * session runs: the model is this Polaris's compatible API signed in with
 * the person's API key (scope `polar.use`), so their routing, keys and
 * fallbacks apply. The hooks the engine fires become the protocol: a tool
 * call is a `tool_call` update and its result a `tool_call_update`, every
 * permission the engine asks is a `session/request_permission`, and text is
 * streamed as `agent_message_chunk` once each step is written. Files and
 * commands use the editor's own `fs` and `terminal` when it offers them
 * (`acp-workspace.ts`). Every conversation is kept as the engine's own
 * transcript beside the other native ones, so `session/load` replays it to
 * the editor and continues it. The editor's model picker is the session's
 * `model` config option, listing what the key's owner can address.
 *
 * Every inbound frame is held to the JSON-RPC envelope (`agents/acp/frames`)
 * before the SDK parses each method's params against the protocol's own
 * generated schema. Server-free, like the rest of the bundle.
 */

import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import type { LanguageModel } from "ai";
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { discoverRules } from "@/lib/polar/native/rules";
import { NativeSession } from "@/lib/polar/native/engine";
import { transcriptDir } from "@/lib/polar/native/launch";
import { nodeWorkspace } from "@/lib/polar/native/workspace";
import { acpWorkspace } from "@/lib/polar/native/acp-workspace";
import { INTERRUPTED_TEXT } from "@/lib/polar/native/transcript";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { MAX_FRAME_BYTES, validatedFrames } from "@/lib/agents/acp/frames";
import { CONVERSATION_ID, replayTranscript } from "@/lib/polar/native/resume";
import { PERMISSION_MODES, type PermissionMode } from "@/lib/polar/native/tools";
import type { HookDecision, HookPayload, HookSink } from "@/lib/polar/native/hooks";

/** The model a session asks for when the editor names none: an id with no
 *  provider resolves to the person's default model, else automatic
 *  (`compat/route-model.ts`). */
export const ACP_DEFAULT_MODEL = "polar";

/** What `polaris-agent acp` reads from the environment the editor gives it. */
export const acpEnvSchema = z.object({
    POLARIS_URL: z
        .string()
        .trim()
        .url()
        .refine((value) => /^https?:\/\//.test(value), "must be http(s)")
        .transform((value) => value.replace(/\/+$/, "")),
    POLARIS_API_KEY: z.string().trim().min(16).max(512),
    POLARIS_MODEL: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,199}$/)
        .default(ACP_DEFAULT_MODEL)
});

export type AcpConfig = z.infer<typeof acpEnvSchema>;

/** The config, or the names of the variables that are missing or malformed. */
export function readAcpEnv(env: NodeJS.ProcessEnv): { config: AcpConfig } | { invalid: string[] } {
    const parsed = acpEnvSchema.safeParse(env);
    if (parsed.success) return { config: parsed.data };
    return { invalid: [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))].sort() };
}

/** The modes an editor can switch between; the engine's own permission modes. */
export const ACP_MODES: readonly acp.SessionMode[] = [
    { id: "default", name: "Ask", description: "Asks before changing files or running commands." },
    { id: "acceptEdits", name: "Accept edits", description: "Edits files without asking; still asks for commands." },
    { id: "plan", name: "Plan", description: "Reads and plans; changes nothing until the plan is approved." },
    { id: "bypassPermissions", name: "Don't ask", description: "Never asks." }
];

const promptBlock = z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }).passthrough(),
    z.object({ type: z.literal("resource_link"), uri: z.string(), name: z.string().optional() }).passthrough(),
    z
        .object({
            type: z.literal("resource"),
            resource: z.object({ uri: z.string(), text: z.string().optional() }).passthrough()
        })
        .passthrough(),
    z.object({ type: z.literal("image") }).passthrough(),
    z.object({ type: z.literal("audio") }).passthrough()
]);

/** The prompt as the one message the engine takes. A linked file is named for
 *  the model to Read; an embedded one is inlined; media is not offered
 *  (`promptCapabilities`), so it is skipped. */
export function promptText(blocks: readonly unknown[]): string {
    const parts: string[] = [];
    for (const raw of blocks) {
        const parsed = promptBlock.safeParse(raw);
        if (!parsed.success) continue;
        const block = parsed.data;
        if (block.type === "text") parts.push(block.text);
        else if (block.type === "resource_link") parts.push(`@${fileOf(block.uri)}`);
        else if (block.type === "resource") {
            const file = fileOf(block.resource.uri);
            parts.push(block.resource.text === undefined ? `@${file}` : `<file path="${file}">\n${block.resource.text}\n</file>`);
        }
    }
    return parts.join("\n\n").trim();
}

function fileOf(uri: string): string {
    if (!uri.startsWith("file://")) return uri;
    try {
        const pathname = decodeURIComponent(new URL(uri).pathname);
        // file:///C:/x on Windows: drop the slash before the drive.
        return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
    } catch {
        return uri;
    }
}

/** What kind of work a tool is, for the editor's icon. */
export function toolKind(name: string): acp.ToolKind {
    if (name === "Read" || name === "LS") return "read";
    if (name === "Edit" || name === "MultiEdit" || name === "Write" || name === "NotebookEdit") return "edit";
    if (name === "Glob" || name === "Grep") return "search";
    if (name === "Bash" || name === "BashOutput" || name === "KillShell" || name === "KillBash") return "execute";
    if (name === "WebFetch" || name === "WebSearch") return "fetch";
    if (name === "ExitPlanMode") return "switch_mode";
    if (name === "TodoWrite" || name === "Task") return "think";
    return "other";
}

function stringField(input: unknown, key: string): string | null {
    const value = (input as Record<string, unknown> | null)?.[key];
    return typeof value === "string" && value.trim() ? value : null;
}

/** A tool call's title, file and (for an edit) its diff, from its input. */
export function describeCall(name: string, input: unknown): Pick<acp.ToolCall, "title" | "kind" | "locations" | "content"> {
    const file = stringField(input, "file_path") ?? stringField(input, "notebook_path") ?? stringField(input, "path");
    const detail = stringField(input, "command") ?? stringField(input, "pattern") ?? stringField(input, "url") ?? file;
    const title = detail ? `${name}: ${detail.split("\n")[0]!.slice(0, 160)}` : name;
    const content: acp.ToolCallContent[] = [];
    if (file && name === "Edit") {
        const oldText = stringField(input, "old_string");
        const newText = (input as Record<string, unknown>)?.new_string;
        if (typeof newText === "string") content.push({ type: "diff", path: file, oldText, newText });
    } else if (file && name === "Write") {
        const newText = (input as Record<string, unknown>)?.content;
        if (typeof newText === "string") content.push({ type: "diff", path: file, oldText: null, newText });
    }
    return {
        title,
        kind: toolKind(name),
        ...(file ? { locations: [{ path: file }] } : {}),
        ...(content.length ? { content } : {})
    };
}

/** The engine's answer for a permission prompt, from the option picked. */
export function permissionDecision(
    outcome: acp.RequestPermissionResponse["outcome"] | null,
    tool: string
): HookDecision {
    const picked = outcome?.outcome === "selected" ? outcome.optionId : null;
    if (picked === "allow" || picked === "allow_always") {
        return {
            hookSpecificOutput: {
                hookEventName: "PermissionRequest",
                decision: {
                    behavior: "allow",
                    ...(picked === "allow_always"
                        ? { updatedPermissions: [{ type: "addRules", rules: [{ toolName: tool }], behavior: "allow", destination: "session" }] }
                        : {})
                }
            }
        };
    }
    return {
        hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: {
                behavior: "deny",
                message: picked ? "The user rejected this call. Do something else or ask in your reply." : "The user did not answer."
            }
        }
    };
}

const PERMISSION_OPTIONS: acp.PermissionOption[] = [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
    { optionId: "reject", name: "Reject", kind: "reject_once" }
];

const PLAN_OPTIONS: acp.PermissionOption[] = [
    { optionId: "allow", name: "Approve the plan", kind: "allow_once" },
    { optionId: "reject", name: "Keep planning", kind: "reject_once" }
];

/** Where each ACP conversation's transcript is kept, so `session/load` can
 *  read it back. Ids reaching `read` are held to `CONVERSATION_ID` first. */
export interface AcpStore {
    append(id: string, line: string): void;
    read(id: string): string | null;
}

/** The transcripts beside every other native conversation's
 *  (`transcriptDir()`), one `<sessionId>.jsonl` each. */
export function fileAcpStore(dir: string = transcriptDir()): AcpStore {
    let made = false;
    const file = (id: string) => path.join(dir, `${id}.jsonl`);
    return {
        append(id, line) {
            if (!made) fs.mkdirSync(dir, { recursive: true });
            made = true;
            fs.appendFileSync(file(id), `${line}\n`);
        },
        read(id) {
            try {
                return fs.readFileSync(file(id), "utf8");
            } catch {
                return null;
            }
        }
    };
}

interface ReplayBlock {
    readonly type?: unknown;
    readonly text?: unknown;
    readonly id?: unknown;
    readonly name?: unknown;
    readonly input?: unknown;
    readonly tool_use_id?: unknown;
    readonly content?: unknown;
    readonly is_error?: unknown;
}

/** A stored transcript as the updates an editor shows, in order, for
 *  `session/load` to replay: what the person typed, what Polar answered, each
 *  call as finished, and a failed one as failed. A subagent's own lines and
 *  the compaction summary are not part of the conversation shown. */
export function replayUpdates(text: string): acp.SessionUpdate[] {
    const updates: acp.SessionUpdate[] = [];
    for (const raw of text.split("\n")) {
        let record: {
            type?: unknown;
            isSidechain?: unknown;
            isCompactSummary?: unknown;
            message?: { content?: unknown };
        };
        try {
            record = JSON.parse(raw) as typeof record;
        } catch {
            continue;
        }
        if (!record || typeof record !== "object" || record.isSidechain === true || record.isCompactSummary === true) continue;
        const content = record.message?.content;
        const blocks: ReplayBlock[] =
            typeof content === "string"
                ? [{ type: "text", text: content }]
                : Array.isArray(content)
                  ? content.filter((block): block is ReplayBlock => Boolean(block) && typeof block === "object")
                  : [];
        for (const block of blocks) {
            const said = block.type === "text" && typeof block.text === "string" && block.text ? block.text : null;
            if (record.type === "user") {
                if (said && said !== INTERRUPTED_TEXT) {
                    updates.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text: said } });
                } else if (block.type === "tool_result" && block.is_error === true && typeof block.tool_use_id === "string") {
                    const failure = typeof block.content === "string" ? block.content : "";
                    updates.push({
                        sessionUpdate: "tool_call_update",
                        toolCallId: block.tool_use_id,
                        status: "failed",
                        ...(failure ? { content: [{ type: "content", content: { type: "text", text: failure } }] } : {})
                    });
                }
            } else if (record.type === "assistant") {
                if (said) updates.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: said } });
                else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
                    updates.push({
                        sessionUpdate: "tool_call",
                        toolCallId: block.id,
                        status: "completed",
                        rawInput: block.input,
                        ...describeCall(block.name, block.input)
                    });
                }
            }
        }
    }
    return updates;
}

/** The sentence a session opens with when the editor listed MCP servers:
 *  the engine has no MCP client, so none of them is mounted. */
export function mcpNotice(servers: readonly { name: string }[]): string | null {
    if (servers.length === 0) return null;
    const names = servers.slice(0, 10).map((server) => server.name.slice(0, 80));
    const more = servers.length > names.length ? ` and ${servers.length - names.length} more` : "";
    return `This editor listed MCP servers (${names.join(", ")}${more}). Polar does not mount an editor's MCP servers yet, so their tools are not available in this session.`;
}

/** What the agent needs to build a session; replaceable in tests. */
export interface AcpAgentDeps {
    readonly model: (id: string) => LanguageModel;
    readonly modelName: string;
    /** Throws a readable error when Polaris will not serve this key. */
    readonly checkAccess?: () => Promise<void>;
    readonly now?: () => Date;
    readonly newId?: () => string;
    /** The rules files the session reads (`discoverRules`). */
    readonly rules?: (cwd: string) => { file: string; text: string }[];
    /** Where transcripts are kept for `session/load` (`fileAcpStore`). */
    readonly store?: AcpStore;
    /** The models the key's owner can pick (`acpModels`); asked once. */
    readonly models?: () => Promise<readonly AcpModelChoice[]>;
}

interface LiveSession {
    readonly engine: NativeSession;
    /** Settles once every message chunk written so far reached the editor. */
    readonly flushed: () => Promise<void>;
    readonly notify: Notify;
    turn: AbortController | null;
    mode: PermissionMode;
    /** Said once, before the session's next answer (`mcpNotice`). */
    notice: string | null;
    /** The model id the next step is sent to. */
    model: string;
}

type Notify = (update: acp.SessionUpdate) => Promise<void>;

/** The engine's hooks as protocol traffic for one session. */
function protocolHooks(
    client: acp.AgentContext,
    sessionId: string,
    notify: Notify,
    current: { call: string | null; mode: PermissionMode }
): HookSink {
    const announced = new Set<string>();
    const announce = async (payload: HookPayload) => {
        const id = String(payload.tool_use_id ?? "");
        if (!id || announced.has(id)) return;
        announced.add(id);
        current.call = id;
        await notify({
            sessionUpdate: "tool_call",
            toolCallId: id,
            status: "pending",
            rawInput: payload.tool_input,
            ...describeCall(String(payload.tool_name ?? "tool"), payload.tool_input)
        });
    };
    const modeChanged = async (payload: HookPayload) => {
        const mode = payload.permission_mode as PermissionMode;
        if (mode === current.mode || !(PERMISSION_MODES as readonly string[]).includes(mode)) return;
        current.mode = mode;
        await notify({ sessionUpdate: "current_mode_update", currentModeId: mode });
    };
    return {
        async event(payload) {
            const name = payload.hook_event_name;
            if (name === "PreToolUse") await announce(payload);
            else if (name === "PostToolUse" || name === "PostToolUseFailure") {
                const id = String(payload.tool_use_id ?? "");
                if (current.call === id) current.call = null;
                const text = typeof payload.tool_response === "string" ? payload.tool_response : "";
                await notify({
                    sessionUpdate: "tool_call_update",
                    toolCallId: id,
                    status: name === "PostToolUse" ? "completed" : "failed",
                    ...(text ? { content: [{ type: "content", content: { type: "text", text } }] } : {})
                });
                await modeChanged(payload);
            }
        },
        async decide(payload, signal) {
            const tool = String(payload.tool_name ?? "");
            await announce(payload);
            if (payload.hook_event_name === "PreToolUse" && tool !== "ExitPlanMode") {
                // A question: the stable protocol has no way to ask one.
                return {
                    hookSpecificOutput: {
                        hookEventName: "PreToolUse",
                        permissionDecision: "deny",
                        permissionDecisionReason:
                            "This editor cannot show questions. Ask them in your reply and stop, so the user answers in their next message."
                    }
                };
            }
            const id = String(payload.tool_use_id ?? "");
            let outcome: acp.RequestPermissionResponse["outcome"] | null = null;
            try {
                const answer = await client.request(
                    acp.methods.client.session.requestPermission,
                    {
                        sessionId,
                        toolCall: {
                            toolCallId: id,
                            status: "pending",
                            rawInput: payload.tool_input,
                            ...describeCall(tool, payload.tool_input)
                        },
                        options: tool === "ExitPlanMode" ? PLAN_OPTIONS : PERMISSION_OPTIONS
                    },
                    { cancellationSignal: signal }
                );
                outcome = answer.outcome;
            } catch {
                outcome = null;
            }
            if (payload.hook_event_name === "PreToolUse") {
                const approved = outcome?.outcome === "selected" && outcome.optionId === "allow";
                return {
                    hookSpecificOutput: {
                        hookEventName: "PreToolUse",
                        permissionDecision: approved ? "allow" : "deny",
                        permissionDecisionReason: approved ? "" : "The user did not approve the plan yet. Keep planning."
                    }
                };
            }
            const decision = permissionDecision(outcome, tool);
            if (outcome?.outcome !== "selected" || !outcome.optionId.startsWith("allow")) {
                await notify({ sessionUpdate: "tool_call_update", toolCallId: id, status: "failed" });
            }
            return decision;
        }
    };
}

/** The text blocks of one transcript line the engine wrote, when it is the
 *  main conversation's assistant step. */
export function assistantText(line: string): string {
    try {
        const record = JSON.parse(line) as {
            type?: string;
            isSidechain?: boolean;
            message?: { content?: { type?: string; text?: string }[] };
        };
        if (record.type !== "assistant" || record.isSidechain) return "";
        return (record.message?.content ?? [])
            .filter((block) => block.type === "text" && typeof block.text === "string")
            .map((block) => block.text as string)
            .join("\n\n");
    } catch {
        return "";
    }
}

/** The ACP agent: an app the SDK connects to a stream (or, in a test, to a
 *  client app). */
export function createAcpAgent(deps: AcpAgentDeps): acp.AgentApp {
    const sessions = new Map<string, LiveSession>();
    let capabilities: acp.ClientCapabilities | undefined;
    const newId = deps.newId ?? (() => crypto.randomUUID());
    const rules = deps.rules ?? ((cwd: string) => discoverRules({ cwd }).map(({ file, text }) => ({ file, text })));
    let fileStore: AcpStore | null = null;
    const store = () => deps.store ?? (fileStore ??= fileAcpStore());
    const modes = () => ({ currentModeId: "default", availableModes: [...ACP_MODES] });
    let listed: Promise<readonly AcpModelChoice[]> | null = null;
    const models = (): Promise<readonly AcpModelChoice[]> => {
        if (!deps.models) return Promise.resolve([]);
        // Once per process; a failed listing is asked again next time.
        listed ??= deps.models().catch(() => {
            listed = null;
            return [];
        });
        return listed;
    };
    const configOptions = async (live: LiveSession) => modelOption(live.model, await models(), deps.modelName);

    /** One conversation's engine, wired to this editor; a new one or one
     *  read back from its transcript. */
    const open = (sessionId: string, cwd: string, client: acp.AgentContext, servers: readonly { name: string }[]) => {
        sessions.get(sessionId)?.turn?.abort(new Error("reopened"));
        const notify: Notify = (update) => client.notify(acp.methods.client.session.update, { sessionId, update });
        const current = { call: null as string | null, mode: "default" as PermissionMode };
        const ws = acpWorkspace(nodeWorkspace(cwd), {
            sessionId,
            capabilities,
            client: client as never,
            onTerminal: (terminalId) => {
                if (current.call) {
                    void notify({
                        sessionUpdate: "tool_call_update",
                        toolCallId: current.call,
                        status: "in_progress",
                        content: [{ type: "terminal", terminalId }]
                    });
                }
            }
        });
        let streamed: Promise<void> = Promise.resolve();
        const engine = new NativeSession({
            sessionId,
            ws,
            model: deps.model(deps.modelName),
            modelName: deps.modelName,
            hooks: protocolHooks(client, sessionId, notify, current),
            writeTranscript: (line) => {
                store().append(sessionId, line);
                const text = assistantText(line);
                if (!text) return;
                streamed = streamed.then(() =>
                    notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } })
                );
            },
            transcriptPath: path.join(transcriptDir(), `${sessionId}.jsonl`),
            environment: {
                platform: process.platform,
                shell: process.platform === "win32" ? "bash" : "sh",
                branch: null,
                repository: null,
                place: "computer",
                date: (deps.now?.() ?? new Date()).toISOString().slice(0, 10),
                memory: rules(cwd),
                task: null
            }
        });
        const live: LiveSession = {
            engine,
            flushed: () => streamed,
            notify,
            turn: null,
            mode: "default",
            model: deps.modelName,
            notice: mcpNotice(servers)
        };
        sessions.set(sessionId, live);
        return live;
    };

    return acp
        .agent({ name: "polar" })
        .onRequest(acp.methods.agent.initialize, ({ params }) => {
            capabilities = params.clientCapabilities;
            return {
                protocolVersion: acp.PROTOCOL_VERSION,
                agentCapabilities: {
                    loadSession: true,
                    promptCapabilities: { image: false, audio: false, embeddedContext: true },
                    // The engine has no MCP client: only stdio is a transport
                    // an editor offers by default, and it is named, not mounted.
                    mcpCapabilities: { http: false, sse: false }
                },
                authMethods: [],
                agentInfo: { name: "polar", title: "Polar", version: "1" }
            };
        })
        .onRequest(acp.methods.agent.session.new, async ({ params, client }) => {
            if (!path.isAbsolute(params.cwd)) throw acp.RequestError.invalidParams({ cwd: "must be absolute" });
            await deps.checkAccess?.();
            const sessionId = newId();
            const live = open(sessionId, params.cwd, client, params.mcpServers);
            await live.engine.start("startup");
            return { sessionId, modes: modes(), configOptions: await configOptions(live) };
        })
        .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
            if (!path.isAbsolute(params.cwd)) throw acp.RequestError.invalidParams({ cwd: "must be absolute" });
            if (!CONVERSATION_ID.test(params.sessionId)) throw acp.RequestError.sessionNotFound(params.sessionId);
            const text = store().read(params.sessionId);
            if (text === null) throw acp.RequestError.sessionNotFound(params.sessionId);
            await deps.checkAccess?.();
            const live = open(params.sessionId, params.cwd, client, params.mcpServers);
            live.engine.restore(replayTranscript(text));
            // The spec: the whole conversation is replayed before the answer.
            for (const update of replayUpdates(text)) await live.notify(update);
            await live.engine.start("resume");
            return { modes: modes(), configOptions: await configOptions(live) };
        })
        .onRequest(acp.methods.agent.session.setConfigOption, async ({ params }) => {
            const live = sessions.get(params.sessionId);
            if (!live) throw acp.RequestError.sessionNotFound(params.sessionId);
            if (params.configId !== "model") throw acp.RequestError.invalidParams({ configId: "unknown option" });
            const value = params.value;
            const choices = await models();
            const known =
                typeof value === "string" &&
                (value === deps.modelName || value === live.model || choices.some((choice) => choice.value === value));
            if (!known) throw acp.RequestError.invalidParams({ value: "not a model this key can use" });
            live.model = value;
            live.engine.setModel(deps.model(value), value);
            return { configOptions: await configOptions(live) };
        })
        .onRequest(acp.methods.agent.session.setMode, ({ params }) => {
            const live = sessions.get(params.sessionId);
            if (!live) throw acp.RequestError.sessionNotFound(params.sessionId);
            if (!(PERMISSION_MODES as readonly string[]).includes(params.modeId)) {
                throw acp.RequestError.invalidParams({ modeId: "unknown mode" });
            }
            live.mode = params.modeId as PermissionMode;
            live.engine.setMode(live.mode);
            return {};
        })
        .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
            const live = sessions.get(params.sessionId);
            if (!live) throw acp.RequestError.sessionNotFound(params.sessionId);
            if (live.turn) throw acp.RequestError.invalidRequest(undefined, "A turn is already running in this session.");
            const text = promptText(params.prompt);
            if (!text) throw acp.RequestError.invalidParams({ prompt: "no text" });
            const controller = new AbortController();
            live.turn = controller;
            try {
                if (live.notice) {
                    const notice = live.notice;
                    live.notice = null;
                    await live.notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${notice}\n\n` } });
                }
                const result = await live.engine.turn(text, controller.signal);
                await live.flushed();
                if (result.interrupted) return { stopReason: "cancelled" };
                return { stopReason: result.stepLimit ? "max_turn_requests" : "end_turn" };
            } catch (error) {
                if (controller.signal.aborted) return { stopReason: "cancelled" };
                // The model's refusal (a spent key, no model) is what the person needs to read.
                await client.notify(acp.methods.client.session.update, {
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: "agent_message_chunk",
                        content: { type: "text", text: `Polaris could not answer: ${(error as Error).message}` }
                    }
                });
                return { stopReason: "end_turn" };
            } finally {
                live.turn = null;
            }
        })
        .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
            sessions.get(params.sessionId)?.turn?.abort(new Error("cancelled"));
        });
}

/** The model through this Polaris's compatible API, signed in with the key. */
export function acpModel(config: AcpConfig, fetchImpl?: typeof fetch) {
    const provider = createOpenAICompatible({
        name: "polaris",
        baseURL: `${config.POLARIS_URL}/api/v1`,
        apiKey: config.POLARIS_API_KEY,
        ...(fetchImpl ? { fetch: fetchImpl } : {})
    });
    return (id: string) => provider(id);
}

/** Asks the compatible API whether it serves this key, without spending a
 *  call (the route's HEAD probe), and says why not in the editor's terms. */
/** A model the editor offers: the id sent, and the name shown. */
export interface AcpModelChoice {
    readonly value: string;
    readonly name: string;
}

/** The most models one listing offers. */
export const ACP_MODELS_MAX = 200;

const modelListSchema = z.object({
    data: z
        .array(
            z.object({
                id: z.string().trim().min(1).max(200),
                display_name: z.string().trim().max(200).optional()
            })
        )
        .max(5000)
});

/** The listing as choices: one per name, the last form listed (the plain
 *  `provider/model` an OpenAI-compatible client sends, `compat/models.ts`),
 *  bounded. */
export function modelChoices(data: readonly { id: string; display_name?: string }[]): AcpModelChoice[] {
    const byName = new Map<string, AcpModelChoice>();
    for (const entry of data) {
        const name = entry.display_name || entry.id;
        byName.delete(name);
        byName.set(name, { value: entry.id, name });
    }
    return [...byName.values()].slice(0, ACP_MODELS_MAX);
}

/** The session's one config option: the model. The one the session started
 *  with (`POLARIS_MODEL`, `polar` for the person's default) is listed first
 *  when the listing does not hold it, so the editor can always go back. */
export function modelOption(
    current: string,
    choices: readonly AcpModelChoice[],
    started: string = current
): acp.SessionConfigOption[] {
    const extra = [...new Set([started, current])]
        .filter((id) => !choices.some((choice) => choice.value === id))
        .map((id) => ({ value: id, name: id === ACP_DEFAULT_MODEL ? "Your default model" : id }));
    const options = [...extra, ...choices];
    return [{ id: "model", name: "Model", category: "model", type: "select", currentValue: current, options }];
}

/** The models this key's owner can address, from the compatible API's
 *  `GET /v1/models`. */
export async function acpModels(config: AcpConfig, fetchImpl: typeof fetch = fetch): Promise<AcpModelChoice[]> {
    const response = await fetchImpl(`${config.POLARIS_URL}/api/v1/models`, {
        headers: { authorization: `Bearer ${config.POLARIS_API_KEY}` },
        signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`Polaris answered ${response.status}.`);
    return modelChoices(modelListSchema.parse(await response.json()).data);
}

export async function checkAcpAccess(config: AcpConfig, fetchImpl: typeof fetch = fetch): Promise<void> {
    let status: number;
    try {
        const response = await fetchImpl(`${config.POLARIS_URL}/api/v1/chat/completions`, {
            method: "HEAD",
            headers: { authorization: `Bearer ${config.POLARIS_API_KEY}` },
            signal: AbortSignal.timeout(15_000)
        });
        status = response.status;
    } catch {
        throw acp.RequestError.internalError(undefined, `Polaris at ${config.POLARIS_URL} could not be reached.`);
    }
    if (status === 401) throw acp.RequestError.authRequired(undefined, "Polaris did not accept POLARIS_API_KEY. Create a key with the Polar permission.");
    if (status === 403) throw acp.RequestError.authRequired(undefined, "This API key or account is not allowed to use Polar.");
    if (status >= 400) throw acp.RequestError.internalError(undefined, `Polaris answered ${status}.`);
}

/** Serves the agent on standard input and output until the editor closes it. */
export async function runAcp(env: NodeJS.ProcessEnv): Promise<number> {
    const read = readAcpEnv(env);
    if ("invalid" in read) {
        process.stderr.write(`polaris-agent acp: missing or malformed: ${read.invalid.join(", ")}\n`);
        return 2;
    }
    const config = read.config;
    // The key is this process's own; nothing the agent runs inherits it.
    delete process.env.POLARIS_API_KEY;
    // Standard output carries only protocol frames.
    console.log = console.error;
    console.info = console.error;
    const framed = acp.ndJsonStream(
        Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
        Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
        { maxMessageBytes: MAX_FRAME_BYTES }
    );
    const stream: acp.Stream = {
        writable: framed.writable,
        readable: framed.readable.pipeThrough(
            validatedFrames((what) => process.stderr.write(`polaris-agent acp: dropped a malformed frame (${what})\n`))
        )
    };
    const connection = createAcpAgent({
        model: acpModel(config),
        modelName: config.POLARIS_MODEL,
        checkAccess: () => checkAcpAccess(config),
        models: () => acpModels(config)
    }).connect(stream);
    await connection.closed;
    return 0;
}
