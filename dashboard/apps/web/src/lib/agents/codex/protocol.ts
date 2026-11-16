/**
 * The part of Codex's app-server protocol a session's Chat uses, as Polaris
 * reads it. Every method, field and value here is from Codex's own
 * documentation (learn.chatgpt.com/docs/app-server: "Initialization",
 * "Threads", "Turns", "Events", "Approvals"), cross-checked against the
 * schema `codex app-server generate-json-schema` prints as Agent
 * Orchestrator checks it in (`codexproto/protocol.gen.go`). Nothing is
 * guessed from a name.
 *
 * Only what is read is described, and loosely past that: a field a newer
 * release adds is ignored, a field Polaris reads that is missing or of the
 * wrong type makes the frame one it does not act on.
 */

import { z } from "zod";
import type * as core from "@polaris/core";
import type { PermissionStatus } from "../session-permissions";

/** The launch line: Codex's app-server on its default transport, stdio JSONL. */
export const CODEX_APP_SERVER_ARGV: readonly string[] = ["codex", "app-server"];

/** What Polaris says it is in `initialize` - the same identity its other
 *  JSON-RPC clients give (`native-models.ts`). */
export const CLIENT_INFO = { name: "polaris", title: "Polaris", version: "1" } as const;

/**
 * Whether `codex app-server --help` came from a Codex that has the
 * subcommand. One that has it prints its own usage line; an older one reads
 * `app-server` as a prompt and prints the top-level usage, which never names
 * it. Pure.
 */
export function hasAppServer(help: string | null): boolean {
    return /\bcodex(?:\.exe)? app-server\b/.test(help ?? "");
}

/**
 * How a Polaris permission mode is put to Codex: the approval policy and the
 * sandbox, in the two spellings the protocol uses for it - `sandbox` (a mode
 * name) on `thread/start`, `sandboxPolicy` (a tagged object) on `turn/start`,
 * where it also becomes the thread's default for later turns.
 *
 * Full access is what the terminal's `--dangerously-bypass-approvals-and-sandbox`
 * gives, so Chat is never stricter than the terminal for the same setting.
 * Only the policies the docs name are used: `on-request` (the agent asks when
 * it needs more than the sandbox) and `never`.
 */
export const MODE_SETTINGS: Readonly<
    Record<
        core.SessionPermissionMode,
        {
            approvalPolicy: "on-request" | "never";
            sandbox: "read-only" | "workspace-write" | "danger-full-access";
            sandboxPolicy: { type: "readOnly" | "workspaceWrite" | "dangerFullAccess" };
        }
    >
> = {
    ask: { approvalPolicy: "on-request", sandbox: "read-only", sandboxPolicy: { type: "readOnly" } },
    edits: { approvalPolicy: "on-request", sandbox: "workspace-write", sandboxPolicy: { type: "workspaceWrite" } },
    plan: { approvalPolicy: "never", sandbox: "read-only", sandboxPolicy: { type: "readOnly" } },
    full: { approvalPolicy: "never", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" } }
};

/** The server->client requests that are an approval Polaris asks the person. */
export const APPROVAL_METHODS = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"] as const;
export type ApprovalMethod = (typeof APPROVAL_METHODS)[number];

export function isApprovalMethod(method: string): method is ApprovalMethod {
    return (APPROVAL_METHODS as readonly string[]).includes(method);
}

const text = (max: number) => z.string().max(max);

export const approvalParamsSchema = z.object({
    threadId: text(256),
    turnId: text(256),
    itemId: text(256),
    reason: text(4_000).nullish(),
    command: text(16_000).nullish(),
    cwd: text(4_096).nullish(),
    grantRoot: text(4_096).nullish(),
    /** Present on newer releases: the decisions this request accepts. */
    availableDecisions: z.array(z.unknown()).max(32).nullish()
});
export type ApprovalParams = z.infer<typeof approvalParamsSchema>;

/**
 * The decision an answer becomes, or `cancel` for no decision. "Always"
 * becomes `acceptForSession` where the request offers it and falls back to a
 * once-only `accept`, never the other way round. Pure.
 */
export function decisionFor(status: PermissionStatus, offered: readonly unknown[] | null | undefined): string {
    const allowed = (decision: string) => !offered || offered.includes(decision);
    if (status === "always" && allowed("acceptForSession")) return "acceptForSession";
    if ((status === "always" || status === "allow") && allowed("accept")) return "accept";
    if (status === "deny" && allowed("decline")) return "decline";
    return "cancel";
}

/** What the prompt names: the command, else the files' root, else the kind. Pure. */
export function approvalPrompt(method: ApprovalMethod, params: ApprovalParams): { tool: string; detail: string } {
    if (method === "item/commandExecution/requestApproval") {
        const detail = [params.command, params.reason].filter(Boolean).join("\n");
        return { tool: "shell", detail: detail.slice(0, 400) };
    }
    const detail = [params.grantRoot, params.reason].filter(Boolean).join("\n");
    return { tool: "apply_patch", detail: detail.slice(0, 400) };
}

export const threadResultSchema = z.object({ thread: z.object({ id: text(256) }) });
export const turnResultSchema = z.object({ turn: z.object({ id: text(256) }) });

export const TURN_STATUSES = ["completed", "interrupted", "failed", "inProgress"] as const;

export const turnCompletedSchema = z.object({
    threadId: text(256).optional(),
    turn: z.object({
        id: text(256),
        status: z.enum(TURN_STATUSES),
        error: z.object({ message: text(4_000) }).nullish()
    })
});

export const itemDeltaSchema = z.object({
    threadId: text(256).optional(),
    itemId: text(256),
    delta: z.string()
});

const textInput = z.object({ type: z.string(), text: z.string().optional() });

/** The `ThreadItem` kinds a history row is made from. Any other kind is skipped. */
export const threadItemSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("userMessage"), id: text(256), content: z.array(textInput).max(256) }),
    z.object({ type: z.literal("agentMessage"), id: text(256), text: z.string() }),
    z.object({ type: z.literal("plan"), id: text(256), text: z.string() }),
    z.object({
        type: z.literal("commandExecution"),
        id: text(256),
        command: z.string(),
        status: z.string().max(64),
        aggregatedOutput: z.string().nullish(),
        exitCode: z.number().int().nullish()
    }),
    z.object({
        type: z.literal("fileChange"),
        id: text(256),
        status: z.string().max(64),
        changes: z.array(z.object({ path: z.string(), kind: z.unknown().optional() })).max(10_000)
    }),
    z.object({
        type: z.literal("mcpToolCall"),
        id: text(256),
        server: z.string(),
        tool: z.string(),
        status: z.string().max(64),
        arguments: z.unknown().optional(),
        result: z.unknown().optional(),
        error: z.unknown().optional()
    }),
    z.object({ type: z.literal("webSearch"), id: text(256), query: z.string() }),
    z.object({ type: z.literal("contextCompaction"), id: text(256) })
]);
export type ThreadItem = z.infer<typeof threadItemSchema>;

export const itemEventSchema = z.object({
    threadId: text(256).optional(),
    item: z.object({ type: z.string(), id: text(256) }).passthrough()
});
