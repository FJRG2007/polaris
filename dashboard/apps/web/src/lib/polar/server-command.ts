/**
 * Polar running one command on a registered server: the parts both the chat
 * route and the chat's card read. Pure, and safe in the browser.
 *
 * The rules this file holds:
 *
 * - Every call waits for the person's card, read-only ones included. Nothing
 *   here guesses from the command text whether it is safe: a regex that reads
 *   `cat` as harmless also reads `cat > /etc/passwd` that way.
 * - "Always for this server" holds for the rest of this conversation only, for
 *   that one server and that one account, and is read back from the
 *   conversation's own approval answers - never stored, never widened.
 * - The command reaches the machine on the SSH channel's stdin, read by `sh -s`
 *   there, so nothing the model wrote is ever put inside a command line - not
 *   here, not on the server. The working directory is the one value placed in
 *   the script, single-quoted.
 * - Output is bounded (head and tail kept, the middle dropped and said so) and
 *   reaches the model fenced: it is the machine's text, never instructions.
 */

import { z } from "zod";

/** The tool's name, as the model and the chat's card see it. */
export const SERVER_COMMAND_TOOL = "server_run_command";

/** The reason the card stores when the person picks "Always for this server". */
export const ALWAYS_SERVER_REASON = "always-server";

/** Longest command accepted. A script longer than this belongs in a file. */
export const COMMAND_MAX = 8000;
/** Default and longest time one command may run, in seconds. */
export const TIMEOUT_DEFAULT_S = 60;
export const TIMEOUT_MAX_S = 600;
/** Bytes kept from the start and from the end of each stream. */
export const OUTPUT_HEAD_BYTES = 8 * 1024;
export const OUTPUT_TAIL_BYTES = 8 * 1024;
/** Seconds `timeout` waits after TERM before it sends KILL. */
const KILL_AFTER_S = 5;
/** Seconds past the command's own limit before the connection itself is cut. */
export const BACKSTOP_S = 15;

/** A control character other than a tab or a line break. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

export const serverCommandInput = z.object({
    /** The server's id. Left out, the server Polar was asked from. */
    serverId: z.string().trim().min(1).max(64).optional(),
    command: z
        .string()
        .max(COMMAND_MAX)
        .refine((value) => value.trim().length > 0, "empty")
        .refine((value) => !CONTROL.test(value.replace(/\r\n/g, "\n")), "control"),
    /** An absolute directory to run in; the account's home when left out. */
    cwd: z
        .string()
        .trim()
        .max(1024)
        .regex(/^\//, "absolute")
        .refine((value) => !CONTROL.test(value), "control")
        .optional(),
    timeoutSeconds: z.number().int().min(1).max(TIMEOUT_MAX_S).optional(),
    /** Root only where the terminal Polar was asked from is a root shell. */
    account: z.enum(["login", "root"]).optional()
});
export type ServerCommandInput = z.infer<typeof serverCommandInput>;

/** The server a chat was opened from, sent with every turn of it. */
export const serverBindingSchema = z.object({
    id: z.string().trim().min(1).max(64),
    root: z.boolean().default(false)
});
export type ServerBinding = z.infer<typeof serverBindingSchema>;

export const serverCommandOutput = z.object({
    ok: z.boolean(),
    server: z.string().optional(),
    account: z.string().optional(),
    exitCode: z.number().int().nullable().optional(),
    timedOut: z.boolean().optional(),
    truncated: z.boolean().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    text: z.string().optional()
});
export type ServerCommandOutput = z.infer<typeof serverCommandOutput>;

/** Which server and account a call is for, with the chat's binding filled in. */
export function resolveCall(
    input: ServerCommandInput,
    binding: ServerBinding | null
): { serverId: string; root: boolean } | null {
    const serverId = input.serverId ?? binding?.id;
    if (!serverId) return null;
    const bound = binding !== null && binding.id === serverId;
    const account = input.account ?? (bound && binding.root ? "root" : "login");
    return { serverId, root: account === "root" };
}

/** Whether root may be used for this call: only on the server the chat is
 *  bound to, and only when the terminal it came from was a root shell. The
 *  server's own sudo grant is checked again where the call runs. */
export function rootAllowed(serverId: string, binding: ServerBinding | null): boolean {
    return binding !== null && binding.id === serverId && binding.root;
}

/** A value as one single-quoted shell word. */
export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The fixed command line the SSH channel runs. Only the timeout, an integer
 * this file bounds, is put into it; the command itself arrives on stdin.
 */
export function remoteCommandLine(timeoutSeconds: number, root: boolean): string {
    const seconds = Math.max(1, Math.min(TIMEOUT_MAX_S, Math.floor(timeoutSeconds)));
    const run = `timeout -k ${KILL_AFTER_S} ${seconds} sh -s`;
    // `-n` never prompts; `-i` gives root's own login environment, as the
    // terminal's root shell does (`openRootShell`).
    return root ? `sudo -n -i ${run}` : run;
}

/** The script fed to `sh -s`: the directory change, then the command. */
export function remoteScript(command: string, cwd: string | undefined): string {
    const body = command.replace(/\r\n/g, "\n");
    const change = cwd ? `cd -- ${shellQuote(cwd)} || exit 1\n` : "";
    return `${change}${body}\n`;
}

/** What `timeout` exits with when it had to stop the command. */
export const TIMEOUT_EXIT_CODES: ReadonlySet<number> = new Set([124, 137]);

/**
 * One output stream, bounded: the first `head` bytes and the last `tail`
 * bytes are kept, the middle counted and dropped.
 */
export class BoundedOutput {
    private readonly start: Buffer[] = [];
    private startSize = 0;
    private end: Buffer = Buffer.alloc(0);
    total = 0;

    constructor(
        private readonly head = OUTPUT_HEAD_BYTES,
        private readonly tail = OUTPUT_TAIL_BYTES
    ) {}

    push(chunk: Buffer): void {
        this.total += chunk.length;
        let rest = chunk;
        if (this.startSize < this.head) {
            const take = rest.subarray(0, this.head - this.startSize);
            this.start.push(Buffer.from(take));
            this.startSize += take.length;
            rest = rest.subarray(take.length);
        }
        if (rest.length === 0) return;
        const joined = Buffer.concat([this.end, rest]);
        this.end = Buffer.from(joined.subarray(Math.max(0, joined.length - this.tail)));
    }

    get truncated(): boolean {
        return this.total > this.head + this.tail;
    }

    /** The kept text, with the dropped middle named in place. */
    text(): string {
        const first = Buffer.concat(this.start).toString("utf8");
        const last = this.end.toString("utf8");
        if (!this.truncated) return cleanOutput(first + last);
        const dropped = this.total - this.startSize - this.end.length;
        return cleanOutput(`${first}\n[... ${dropped} bytes not shown ...]\n${last}`);
    }
}

/** Terminal escapes and stray control characters out; tabs and lines kept. */
export function cleanOutput(text: string): string {
    return text
        .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
        .replace(/\r\n?/g, "\n")
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

const FENCE = "untrusted_command_output";

/** A stream's text as the model reads it: the machine's words, fenced. */
export function fenceOutput(source: string, text: string): string {
    const clean = text.replace(new RegExp(`</?${FENCE}[^>]*>`, "gi"), "");
    return [`<${FENCE} source="${source.replace(/["<>]/g, "")}">`, clean, `</${FENCE}>`].join("\n");
}

/** The slice of a model message the approval check reads. */
export interface ModelMessageLike {
    role: string;
    content: unknown;
}

interface ContentPart {
    type?: string;
    toolCallId?: string;
    toolName?: string;
    input?: unknown;
    approvalId?: string;
    approved?: boolean;
    reason?: string;
}

function partsOf(messages: readonly ModelMessageLike[]): ContentPart[] {
    return messages.flatMap((message) =>
        Array.isArray(message.content) ? (message.content as ContentPart[]) : []
    );
}

/** "server\u0000root" - what an "Always for this server" answer covers. */
function scopeKey(serverId: string, root: boolean): string {
    return `${serverId}\u0000${root ? "root" : "login"}`;
}

/** The server and account each earlier call of this tool was for. */
function callScopes(
    parts: readonly ContentPart[],
    binding: ServerBinding | null
): Map<string, string> {
    const calls = new Map<string, string>();
    for (const part of parts) {
        if (part.type !== "tool-call" || part.toolName !== SERVER_COMMAND_TOOL || !part.toolCallId)
            continue;
        const parsed = serverCommandInput.safeParse(part.input);
        if (!parsed.success) continue;
        const call = resolveCall(parsed.data, binding);
        if (call) calls.set(part.toolCallId, scopeKey(call.serverId, call.root));
    }
    return calls;
}

/** The servers (with account) this conversation said "Always" to. */
export function serversAlwaysIn(
    messages: readonly ModelMessageLike[],
    binding: ServerBinding | null
): Set<string> {
    const parts = partsOf(messages);
    const calls = callScopes(parts, binding);
    const asked = new Map<string, string>();
    for (const part of parts) {
        if (part.type !== "tool-approval-request" || !part.approvalId || !part.toolCallId) continue;
        const scope = calls.get(part.toolCallId);
        if (scope) asked.set(part.approvalId, scope);
    }
    const always = new Set<string>();
    for (const part of parts) {
        if (part.type !== "tool-approval-response" || !part.approved || !part.approvalId) continue;
        if (part.reason !== ALWAYS_SERVER_REASON) continue;
        const scope = asked.get(part.approvalId);
        if (scope) always.add(scope);
    }
    return always;
}

/** Whether the person approved this one call on its card. */
export function cardApproved(toolCallId: string, messages: readonly ModelMessageLike[]): boolean {
    const parts = partsOf(messages);
    const approval = parts.find(
        (part) => part.type === "tool-approval-request" && part.toolCallId === toolCallId
    )?.approvalId;
    if (!approval) return false;
    return parts.some(
        (part) =>
            part.type === "tool-approval-response" &&
            part.approvalId === approval &&
            part.approved === true
    );
}

/**
 * Whether a call waits for the card: always, unless this conversation already
 * said "Always" for the same server and account. A call that does not parse
 * or names no server is shown too - it then refuses itself when run.
 */
export function serverCommandNeedsCard(
    input: unknown,
    messages: readonly ModelMessageLike[],
    binding: ServerBinding | null
): boolean {
    const parsed = serverCommandInput.safeParse(input);
    if (!parsed.success) return true;
    const call = resolveCall(parsed.data, binding);
    if (!call) return true;
    return !serversAlwaysIn(messages, binding).has(scopeKey(call.serverId, call.root));
}

/** Whether a call may run now: approved on its card, or covered by "Always". */
export function serverCommandApproved(
    toolCallId: string,
    input: ServerCommandInput,
    messages: readonly ModelMessageLike[],
    binding: ServerBinding | null
): boolean {
    if (cardApproved(toolCallId, messages)) return true;
    const call = resolveCall(input, binding);
    return call !== null && serversAlwaysIn(messages, binding).has(scopeKey(call.serverId, call.root));
}

/** A call as the chat's card shows it; null for any other tool. */
export function serverCommandOf(
    name: string,
    input: unknown
): { command: string; cwd: string | null; serverId: string | null; root: boolean } | null {
    if (name !== SERVER_COMMAND_TOOL) return null;
    const record = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    return {
        command: typeof record.command === "string" ? record.command : "",
        cwd: typeof record.cwd === "string" ? record.cwd : null,
        serverId: typeof record.serverId === "string" ? record.serverId : null,
        root: record.account === "root"
    };
}
