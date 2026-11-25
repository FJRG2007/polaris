/**
 * The agent's tool calls as the steps Polar Code draws: each call paired with
 * its result by the call's id, so a step knows what went in, what came back,
 * whether it is still running and how long it took. Read from the rows every
 * decoder stores (`transcript-decoders.ts`, `acp/normalize.ts`), so a session
 * recorded before the thread drew steps shows its own. Pure and client-safe.
 */

/** What kind of work a step is, for its words and the folded summary. */
export const CODE_STEP_KINDS = ["command", "edit", "read", "search", "web", "task", "other"] as const;

export type CodeStepKind = (typeof CODE_STEP_KINDS)[number];

export type CodeStepState = "running" | "done" | "failed" | "ended";

export interface CodeToolStep {
    /** The tool's own name, or the agent's title for the call. */
    readonly name: string;
    readonly kind: CodeStepKind;
    /** What it was called with: the command, the path, or its input as JSON. */
    readonly input: string;
    /** What it answered, as stored; empty while it runs. */
    readonly output: string;
    readonly state: CodeStepState;
    /** From the call to its result, when both were timed. */
    readonly ms: number | null;
}

/** How each display level shows steps: summary lines only, or cards open. */
export const CODE_STEP_VIEWS = ["compact", "detailed"] as const;

export type CodeStepView = (typeof CODE_STEP_VIEWS)[number];

/** What the competition opens with (Claude Code, Cursor, Codex): one line per
 *  step, details on request. */
export const DEFAULT_CODE_STEP_VIEW: CodeStepView = "compact";

const NAMES: Readonly<Record<Exclude<CodeStepKind, "other">, readonly string[]>> = {
    command: ["bash", "shell", "exec_command", "run_shell_command", "terminal", "execute", "local_shell", "shell_command", "run"],
    edit: ["edit", "multiedit", "write", "apply_patch", "notebookedit", "str_replace", "write_file", "replace", "edit_file", "create_file", "delete", "move"],
    read: ["read", "read_file", "view", "notebookread", "ls", "list_directory", "read_many_files"],
    search: ["grep", "glob", "search", "find", "codebase_search", "search_file_content"],
    web: ["webfetch", "websearch", "web_fetch", "google_web_search", "fetch"],
    task: ["task", "agent"]
};

/** The kind of a call from its name, or from the first word of an agent's
 *  title for it ("Read src/plan.ts", "`npm test`"). */
export function stepKindOf(name: string): CodeStepKind {
    const trimmed = name.trim();
    // ACP agents title a shell call with the command itself, in backticks.
    if (trimmed.startsWith("`")) return "command";
    const words = [trimmed.toLowerCase(), trimmed.split(/\s+/, 1)[0]!.toLowerCase()];
    for (const kind of CODE_STEP_KINDS) {
        if (kind === "other") continue;
        if (words.some((word) => NAMES[kind].includes(word))) return kind;
    }
    return "other";
}

/** The last part of a path, for a step line a person reads. */
export function baseName(path: string): string {
    const clean = path.trim().replace(/[\\/]+$/, "");
    return clean.split(/[\\/]/).at(-1) ?? clean;
}

/** An agent's title for a shell call without the backticks some put round it. */
function unquoted(title: string): string {
    return title.trim().replace(/^`+|`+$/g, "").trim();
}

/**
 * Whether a call the name did not place is a shell command: some agents title
 * one with the command itself, bare ("ls -la | head"), and store that same
 * command as its input. A bare path titled as itself is not one.
 */
function titledByItsCommand(name: string, input: string): boolean {
    const title = unquoted(name).replace(/(\u2026|\.\.\.)$/, "");
    const command = input.trim();
    return title.length > 0 && command.startsWith(title) && /[\s|;&<>$]/.test(command);
}

/** The command a shell step ran: its input, else the agent's title for it. */
export function stepCommand(step: Pick<CodeToolStep, "name" | "input">): string {
    return step.input.trim() || unquoted(step.name);
}

/**
 * A result as the log it is: some agents wrap a command's output in a
 * Markdown fence ("```console" ... "```"), which is markup, not output. A
 * fence cut short by the stored length has no closing line; its opening line
 * goes all the same. Output that only contains a fence further down is left
 * as it is.
 */
export function stepOutputText(output: string): string {
    const text = output.replace(/\r\n/g, "\n").trim();
    const open = /^(`{3,}|~{3,})[\w+.-]*[ \t]*(\n|$)/.exec(text);
    if (!open) return text;
    const body = text.slice(open[0].length);
    const fence = open[1]!;
    if (body.trim() === fence || body.trim() === "") return "";
    const close = body.lastIndexOf(`\n${fence}`);
    if (close !== -1 && body.slice(close + 1 + fence.length).trim() === "") return body.slice(0, close).trimEnd();
    return body.trimEnd();
}

interface StoredRow {
    readonly id: string;
    readonly kind: string;
    readonly subject: string;
    readonly ref: string;
    readonly body: string;
    readonly at: string;
}

/**
 * Each stored call as a step, in the order the calls were made, with its
 * result folded in. A result whose call was never stored is passed over; a
 * call with no result runs while the session is live and has ended after.
 */
export function codeToolSteps(
    rows: readonly StoredRow[],
    live: boolean
): { id: string; at: string; step: CodeToolStep }[] {
    const results = new Map<string, StoredRow>();
    for (const row of rows) if (row.kind === "result" && row.ref) results.set(row.ref, row);
    const steps: { id: string; at: string; step: CodeToolStep }[] = [];
    for (const row of rows) {
        if (row.kind !== "tool") continue;
        const result = row.ref ? results.get(row.ref) : undefined;
        const ms = result ? Date.parse(result.at) - Date.parse(row.at) : NaN;
        steps.push({
            id: row.id,
            at: row.at,
            step: {
                name: row.subject,
                kind: kindOf(row.subject, row.body),
                input: row.body,
                output: result?.body ?? "",
                state: result ? (result.subject === "error" ? "failed" : "done") : live ? "running" : "ended",
                ms: Number.isFinite(ms) && ms >= 0 ? ms : null
            }
        });
    }
    return steps;
}

function kindOf(name: string, input: string): CodeStepKind {
    const kind = stepKindOf(name);
    return kind === "other" && titledByItsCommand(name, input) ? "command" : kind;
}

/** How many steps of each kind, in the order the summary names them. */
export function stepCounts(steps: readonly CodeToolStep[]): { kind: CodeStepKind; count: number }[] {
    const counts = new Map<CodeStepKind, number>();
    for (const step of steps) counts.set(step.kind, (counts.get(step.kind) ?? 0) + 1);
    return CODE_STEP_KINDS.filter((kind) => kind !== "other" && counts.has(kind)).map((kind) => ({
        kind,
        count: counts.get(kind)!
    }));
}

/** Events the thread no longer draws once it has the calls themselves: the
 *  same steps, said with less. */
export const STEP_EVENT_KINDS: ReadonlySet<string> = new Set(["tool.start", "tool.end", "tool.failed"]);

/** A stored or cached display level read defensively; null is "not chosen". */
export function codeStepViewOf(value: unknown): CodeStepView | null {
    return value === "compact" || value === "detailed" ? value : null;
}
