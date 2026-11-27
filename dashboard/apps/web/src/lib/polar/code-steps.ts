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

/**
 * What a step does, finer than its kind: the words a row says ("Searched the
 * web", "Found files"), the target beside them and whether rows of it fold
 * into one ("Read 3 files"). `meta` is the agent's own housekeeping - loading
 * a tool's schema - and is never shown.
 */
export const CODE_STEP_VERBS = [
    "command",
    "shellOutput",
    "killShell",
    "edit",
    "write",
    "delete",
    "read",
    "list",
    "grep",
    "glob",
    "webSearch",
    "webFetch",
    "task",
    "todo",
    "ask",
    "plan",
    "skill",
    "memory",
    "meta",
    "other"
] as const;

export type CodeStepVerb = (typeof CODE_STEP_VERBS)[number];

/**
 * The one table every surface reads a tool call's words from, keyed by the
 * tool's name in lower case: Polaris' own agent (`native/tools.ts`), Claude
 * Code, Codex, Gemini CLI, OpenCode and Cursor. A tool missing here is said by
 * its humanized name (`humanToolName`), never as "Used ToolName".
 */
export const STEP_TOOLS: Readonly<Record<string, CodeStepVerb>> = {
    bash: "command",
    shell: "command",
    exec_command: "command",
    run_shell_command: "command",
    run_terminal_cmd: "command",
    terminal: "command",
    execute: "command",
    local_shell: "command",
    shell_command: "command",
    powershell: "command",
    run: "command",
    bashoutput: "shellOutput",
    taskoutput: "shellOutput",
    write_stdin: "shellOutput",
    monitor: "shellOutput",
    killshell: "killShell",
    killbash: "killShell",
    taskstop: "killShell",
    edit: "edit",
    multiedit: "edit",
    apply_patch: "edit",
    patch: "edit",
    notebookedit: "edit",
    str_replace: "edit",
    search_replace: "edit",
    replace: "edit",
    edit_file: "edit",
    move: "edit",
    write: "write",
    write_file: "write",
    create_file: "write",
    delete: "delete",
    delete_file: "delete",
    read: "read",
    read_file: "read",
    read_many_files: "read",
    view: "read",
    view_image: "read",
    notebookread: "read",
    ls: "list",
    list: "list",
    list_dir: "list",
    list_directory: "list",
    grep: "grep",
    grep_search: "grep",
    search: "grep",
    search_file_content: "grep",
    codebase_search: "grep",
    codesearch: "grep",
    glob: "glob",
    find: "glob",
    file_search: "glob",
    websearch: "webSearch",
    web_search: "webSearch",
    google_web_search: "webSearch",
    webfetch: "webFetch",
    web_fetch: "webFetch",
    fetch: "webFetch",
    task: "task",
    agent: "task",
    todowrite: "todo",
    todoread: "todo",
    update_plan: "todo",
    askuserquestion: "ask",
    exitplanmode: "plan",
    enterplanmode: "plan",
    skill: "skill",
    slashcommand: "skill",
    save_memory: "memory",
    toolsearch: "meta",
    // Polar's own way of finding a tool to load (`tool-relevance.ts`).
    find_tools: "meta",
    listmcpresourcestool: "meta"
};

const VERB_KINDS: Readonly<Record<CodeStepVerb, CodeStepKind>> = {
    command: "command",
    shellOutput: "command",
    killShell: "command",
    edit: "edit",
    write: "edit",
    delete: "edit",
    read: "read",
    list: "read",
    grep: "search",
    glob: "search",
    webSearch: "web",
    webFetch: "web",
    task: "task",
    todo: "other",
    ask: "other",
    plan: "other",
    skill: "other",
    memory: "other",
    meta: "other",
    other: "other"
};

/** The verb a call's name, or the first word of an agent's title for it
 *  ("Read src/plan.ts"), stands for. */
export function stepVerbOf(name: string): CodeStepVerb {
    const trimmed = name.trim();
    // ACP agents title a shell call with the command itself, in backticks.
    if (trimmed.startsWith("`")) return "command";
    const lower = trimmed.toLowerCase();
    return STEP_TOOLS[lower] ?? STEP_TOOLS[lower.split(/\s+/, 1)[0]!] ?? "other";
}

/** The kind of a call from its name, or from the first word of an agent's
 *  title for it ("Read src/plan.ts", "`npm test`"). */
export function stepKindOf(name: string): CodeStepKind {
    return VERB_KINDS[stepVerbOf(name)];
}

/** The verb a stored step is shown with: a call the name did not place but
 *  titled by its own command is a command. */
export function verbOfStep(step: Pick<CodeToolStep, "name" | "kind">): CodeStepVerb {
    const verb = stepVerbOf(step.name);
    return verb === "other" && step.kind === "command" ? "command" : verb;
}

/** Whether a step is the agent's housekeeping, which no surface shows. */
export function isHiddenStep(step: { readonly name: string; }): boolean {
    return stepVerbOf(step.name) === "meta";
}

/**
 * A tool the table does not know, in words: an MCP tool's own name without
 * its server prefix ("mcp__github__create_issue" -> "Create issue", from
 * "Github"), a camel- or snake-cased name split ("ListPullRequests" -> "List
 * pull requests"), and an agent's title kept as it was written.
 */
export function humanToolName(name: string): { readonly label: string; readonly source: string; } {
    const trimmed = name.trim();
    const words = (value: string) =>
        value
            .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
            .replace(/[_.-]+/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
    const sentence = (value: string) => (value ? value[0]!.toUpperCase() + value.slice(1) : value);
    const mcp = /^mcp__(.+?)__(.+)$/.exec(trimmed);
    if (mcp) return { label: sentence(words(mcp[2]!)), source: sentence(words(mcp[1]!)) };
    // A title an agent wrote ("Searching for files") is already words.
    if (/\s/.test(trimmed)) return { label: sentence(trimmed), source: "" };
    return { label: sentence(words(trimmed)), source: "" };
}

/** What a collapsed row names beside its words. `code` is a command or a
 *  pattern, `file` a path shown by its name, `text` a query or a site;
 *  `whole` is all of it, for the hover. */
export type StepTarget =
    | { readonly code: string; readonly whole: string; }
    | { readonly file: string; readonly whole: string; }
    | { readonly text: string; readonly whole: string; };

/** Longest target a row prints before the width cuts it; the hover has it all. */
const TARGET_CHARS = 120;

function firstLine(value: string): string {
    return value.split("\n", 1)[0]!.trim().slice(0, TARGET_CHARS);
}

/** The host a fetched address is on, "docs.example.com", or the text as is. */
export function domainOf(value: string): string {
    try {
        const url = new URL(value.trim());
        return url.hostname.replace(/^www\./, "") || value.trim();
    } catch {
        return value.trim();
    }
}

/**
 * The one thing a step was called with that a person knows it by: the
 * command, the file, the pattern, the query, the site. Null when its input is
 * JSON or empty, which only the opened card shows. Pure.
 */
export function stepTarget(step: Pick<CodeToolStep, "name" | "kind" | "input">): StepTarget | null {
    const verb = verbOfStep(step);
    if (verb === "command") {
        const command = stepCommand(step);
        return command ? { code: firstLine(command), whole: command } : null;
    }
    const input = step.input.trim();
    if (!input || input.startsWith("{") || input.startsWith("[") || verb === "meta") return null;
    switch (verb) {
        case "edit":
        case "write":
        case "delete":
        case "read":
        case "list":
            return /\s/.test(input) ? { text: firstLine(input), whole: input } : { file: baseName(input), whole: input };
        case "grep":
        case "glob":
            return { code: firstLine(input), whole: input };
        case "webFetch":
            return { text: domainOf(input), whole: input };
        default:
            return { text: firstLine(input), whole: input };
    }
}

/** What a finished step found, counted from its output: Claude Code's "Found
 *  12 files", "Read 240 lines". */
export type StepResult =
    | { readonly key: "lines" | "matches" | "files" | "entries" | "sources"; readonly count: number; }
    | { readonly key: "none"; };

/** A finished step's result in a count, or null when there is nothing worth
 *  counting. Pure. */
export function stepResult(step: Pick<CodeToolStep, "name" | "kind" | "output" | "state">): StepResult | null {
    if (step.state !== "done") return null;
    const verb = verbOfStep(step);
    const text = stepOutputText(step.output);
    const lines = text ? text.split("\n").filter((line) => line.trim() !== "") : [];
    switch (verb) {
        case "read":
            return lines.length > 0 ? { key: "lines", count: text.split("\n").length } : null;
        case "grep":
        case "glob": {
            if (lines.length === 0 || /^no (files|matches)( found)?/i.test(lines[0]!)) return { key: "none" };
            const found = /^Found (\d+)/i.exec(lines[0]!);
            return { key: verb === "grep" ? "matches" : "files", count: found ? Number(found[1]) : lines.length };
        }
        case "list":
            return lines.length > 0 ? { key: "entries", count: lines.length } : null;
        case "webSearch": {
            const sources = new Set(text.match(/https?:\/\/[^\s)"'\]>]+/g) ?? []);
            return sources.size > 0 ? { key: "sources", count: sources.size } : null;
        }
        default:
            return null;
    }
}

/** Verbs whose consecutive finished rows fold into one, the way Claude Code
 *  says "Read 3 files" and Codex "Explored". Commands each stay a row. */
export const GROUPED_VERBS: ReadonlySet<CodeStepVerb> = new Set([
    "read",
    "list",
    "grep",
    "glob",
    "webSearch",
    "webFetch",
    "edit",
    "write"
]);

/** A run of entries as the thread draws it: one entry, or a fold of several
 *  steps of the same verb. */
export type StepRun<T> =
    | { readonly kind: "one"; readonly entry: T; }
    | { readonly kind: "group"; readonly verb: CodeStepVerb; readonly entries: readonly T[]; };

/**
 * Consecutive finished steps of the same verb, folded: two reads in a row are
 * "Read 2 files". A running or failed step stays a row of its own, so the live
 * line and a failure are never hidden in a fold; housekeeping steps go. Pure.
 */
export function groupSteps<T extends { readonly step?: CodeToolStep; }>(entries: readonly T[]): StepRun<T>[] {
    const runs: StepRun<T>[] = [];
    let verb: CodeStepVerb | null = null;
    let open: T[] = [];
    const close = () => {
        if (open.length === 1) runs.push({ kind: "one", entry: open[0]! });
        else if (open.length > 1 && verb) runs.push({ kind: "group", verb, entries: open });
        open = [];
        verb = null;
    };
    for (const entry of entries) {
        const step = entry.step;
        if (step && isHiddenStep(step)) continue;
        const next = step ? verbOfStep(step) : null;
        if (step && next && GROUPED_VERBS.has(next) && step.state === "done") {
            if (next !== verb) close();
            verb = next;
            open.push(entry);
            continue;
        }
        close();
        runs.push({ kind: "one", entry });
    }
    close();
    return runs;
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
        // The agent loading a tool's schema is not work anybody asked about.
        if (isHiddenStep({ name: row.subject })) continue;
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
