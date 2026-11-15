/**
 * The native engine's tools.
 *
 * Names and input shapes follow Claude Code's built-in tools
 * (https://code.claude.com/docs/en/tools-reference): they are the interface
 * Polaris already reads from hook payloads - `TodoWrite` in session-asks,
 * `AskUserQuestion` and `ExitPlanMode` on the permission route, `Task` in
 * session-subagents - so a native session's events land in the same code as a
 * Claude Code session's. The behaviour each one documents (read-before-edit, a
 * unique match, the 2-minute default and 10-minute ceiling on a command,
 * results sorted by modification time and capped at 100) is kept; the wording
 * is Polaris's own.
 *
 * Every tool acts through a `Workspace`, so it runs the same in a session
 * container and on the person's computer. Server-free.
 */

import { z } from "zod";
import * as path from "node:path";
import type { BackgroundProcess, Workspace } from "@/lib/polar/native/workspace";

export const PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** What a tool needs a person's yes for, before it runs. */
export type ToolGate = "none" | "edit" | "shell" | "web" | "ask";

export interface TodoItem {
    content: string;
    status: "pending" | "in_progress" | "completed";
    activeForm: string;
}

export interface ShellJob {
    readonly command: string;
    readonly process: BackgroundProcess;
    /** How much of its output has already been handed back. */
    readAt: number;
}

/** What one session's tools remember between calls. */
export interface SessionState {
    cwd: string;
    mode: PermissionMode;
    /** Files read in this session, by absolute path, with the mtime seen. */
    readonly read: Map<string, number>;
    todos: TodoItem[];
    readonly shells: Map<string, ShellJob>;
    nextShell: number;
}

export function sessionState(root: string, mode: PermissionMode = "default"): SessionState {
    return { cwd: root, mode, read: new Map(), todos: [], shells: new Map(), nextShell: 1 };
}

export interface ToolContext {
    readonly ws: Workspace;
    readonly state: SessionState;
    readonly signal: AbortSignal;
    /** Runs a child agent and answers its report; absent inside a child. */
    readonly subagent?: (input: TaskInput, signal: AbortSignal) => Promise<string>;
    /** What a person answered, for the ask tools. */
    readonly answer?: Record<string, unknown>;
}

export interface ToolOutput {
    readonly text: string;
    readonly isError?: boolean;
}

export interface NativeTool<T = unknown> {
    readonly name: string;
    readonly description: string;
    readonly schema: z.ZodType<T>;
    readonly gate: ToolGate;
    /** Changes the checkout: withheld in plan mode. */
    readonly writes: boolean;
    run(input: T, context: ToolContext): Promise<ToolOutput>;
}

// ---------------------------------------------------------------- limits

export const READ_DEFAULT_LINES = 2_000;
export const READ_MAX_LINE_CHARS = 2_000;
/** A whole file larger than this is read in pages. */
export const READ_MAX_BYTES = 256 * 1024;
export const GLOB_MAX_RESULTS = 100;
/** Entries a search walks before it stops and says so. */
export const WALK_MAX_ENTRIES = 50_000;
export const BASH_DEFAULT_TIMEOUT_MS = 120_000;
export const BASH_MAX_TIMEOUT_MS = 600_000;
/** The longest command output handed back to the model. */
export const BASH_MAX_OUTPUT_CHARS = 30_000;
export const GREP_DEFAULT_HEAD = 250;

const fail = (text: string): ToolOutput => ({ text, isError: true });
const ok = (text: string): ToolOutput => ({ text });

/** An absolute path, from one the model gave relative to the shell's folder. */
export function resolvePath(state: SessionState, given: string): string {
    return path.resolve(state.cwd, given);
}

function inside(root: string, target: string): boolean {
    const relative = path.relative(root, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function clipMiddle(text: string, max: number): string {
    if (text.length <= max) return text;
    const half = Math.floor(max / 2);
    const cut = text.length - max;
    return `${text.slice(0, half)}\n\n... [${cut} characters cut] ...\n\n${text.slice(-half)}`;
}

function isBinary(buffer: Buffer): boolean {
    const head = buffer.subarray(0, 8_192);
    return head.includes(0);
}

// ---------------------------------------------------------------- Read

const readInput = z.object({
    file_path: z.string().min(1).describe("The absolute path of the file to read."),
    offset: z.number().int().min(1).optional().describe("The line to start at, 1-based. Only for large files."),
    limit: z.number().int().min(1).optional().describe("How many lines to read. Only for large files.")
});

export const readTool: NativeTool<z.infer<typeof readInput>> = {
    name: "Read",
    description: [
        "Read a file from the workspace. Returns the content with line numbers (cat -n style), starting at line 1.",
        `By default up to ${READ_DEFAULT_LINES} lines are returned; pass offset and limit to page through a longer file.`,
        `Lines longer than ${READ_MAX_LINE_CHARS} characters are cut. A directory path returns its entries.`,
        "Always read a file before editing or overwriting it. Read several files in parallel when you need them."
    ].join(" "),
    schema: readInput,
    gate: "none",
    writes: false,
    async run(input, { ws, state }) {
        const file = resolvePath(state, input.file_path);
        const info = await ws.stat(file);
        if (!info) return fail(`File does not exist: ${file}`);
        if (info.kind === "directory") {
            const entries = await ws.list(file);
            const lines = entries
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((entry) => (entry.kind === "directory" ? `${entry.name}/` : entry.name));
            return ok(lines.length ? lines.join("\n") : "The directory is empty.");
        }
        const buffer = await ws.readFile(file);
        if (isBinary(buffer)) return fail(`${file} is a binary file; inspect it with a shell command instead.`);
        const text = buffer.toString("utf8");
        state.read.set(file, info.mtimeMs);
        if (text.length === 0) return ok(`The file ${file} exists but is empty.`);
        const all = text.split(/\r?\n/);
        if (all.length > 1 && all.at(-1) === "") all.pop();
        const start = (input.offset ?? 1) - 1;
        if (start >= all.length) {
            return ok(`The file has ${all.length} lines; offset ${input.offset} is past its end.`);
        }
        const whole = input.offset === undefined && input.limit === undefined;
        const limit = input.limit ?? READ_DEFAULT_LINES;
        const page = all.slice(start, start + limit);
        const numbered = page
            .map((line, index) => {
                const shown = line.length > READ_MAX_LINE_CHARS ? `${line.slice(0, READ_MAX_LINE_CHARS)}...` : line;
                return `${String(start + index + 1).padStart(6)}\t${shown}`;
            })
            .join("\n");
        const shownTo = start + page.length;
        const partial =
            shownTo < all.length || (whole && buffer.length > READ_MAX_BYTES)
                ? `\n\n[PARTIAL view: lines ${start + 1}-${shownTo} of ${all.length}. Read on with offset ${shownTo + 1}.]`
                : "";
        if (partial) state.read.delete(file);
        return ok(numbered + partial);
    }
};

// ---------------------------------------------------------------- Write

const writeInput = z.object({
    file_path: z.string().min(1).describe("The absolute path of the file to write."),
    content: z.string().describe("The whole new content of the file.")
});

export const writeTool: NativeTool<z.infer<typeof writeInput>> = {
    name: "Write",
    description: [
        "Create a file, or replace one entirely. An existing file must be read in this session first.",
        "Prefer Edit for changing part of a file. Never create documentation files unless asked."
    ].join(" "),
    schema: writeInput,
    gate: "edit",
    writes: true,
    async run(input, { ws, state }) {
        const file = resolvePath(state, input.file_path);
        const info = await ws.stat(file);
        if (info?.kind === "directory") return fail(`${file} is a directory.`);
        if (info && !state.read.has(file)) return fail(`Read ${file} before overwriting it.`);
        if (input.content.includes("�") && info) {
            return fail("The new content contains U+FFFD, which means undecodable bytes were read; refusing to write them back.");
        }
        await ws.writeFile(file, input.content);
        const after = await ws.stat(file);
        if (after) state.read.set(file, after.mtimeMs);
        return ok(info ? `Updated ${file}.` : `Created ${file}.`);
    }
};

// ---------------------------------------------------------------- Edit

const editInput = z.object({
    file_path: z.string().min(1).describe("The absolute path of the file to change."),
    old_string: z.string().describe("The exact text to replace, including whitespace and indentation."),
    new_string: z.string().describe("The text to put in its place. Must differ from old_string."),
    replace_all: z.boolean().optional().describe("Replace every occurrence instead of exactly one.")
});

export const editTool: NativeTool<z.infer<typeof editInput>> = {
    name: "Edit",
    description: [
        "Replace an exact string in a file. No regex, no fuzzy matching.",
        "Read the file first. old_string must appear exactly once unless replace_all is true;",
        "when it appears more than once, include more surrounding lines to make it unique.",
        "Keep the file's indentation exactly as the Read output shows it (after the tab that follows the line number)."
    ].join(" "),
    schema: editInput,
    gate: "edit",
    writes: true,
    async run(input, { ws, state }) {
        const file = resolvePath(state, input.file_path);
        if (input.old_string === input.new_string) return fail("old_string and new_string are identical; nothing to change.");
        const info = await ws.stat(file);
        if (!info) {
            if (input.old_string === "") {
                await ws.writeFile(file, input.new_string);
                return ok(`Created ${file}.`);
            }
            return fail(`File does not exist: ${file}`);
        }
        if (!state.read.has(file)) return fail(`Read ${file} before editing it.`);
        const buffer = await ws.readFile(file);
        const text = buffer.toString("utf8");
        if (text.includes("�")) return fail(`${file} is not valid UTF-8; change it with a shell command instead.`);
        if (input.old_string === "") return fail("old_string is empty; use Write to replace a whole file.");
        const count = text.split(input.old_string).length - 1;
        if (count === 0) return fail(`old_string was not found in ${file}. Read the file again and copy the text exactly.`);
        if (count > 1 && !input.replace_all) {
            return fail(`old_string appears ${count} times in ${file}. Add surrounding context to make it unique, or set replace_all.`);
        }
        const next = input.replace_all
            ? text.split(input.old_string).join(input.new_string)
            : text.replace(input.old_string, () => input.new_string);
        const seen = state.read.get(file) ?? 0;
        await ws.writeFile(file, next);
        const after = await ws.stat(file);
        if (after) state.read.set(file, after.mtimeMs);
        const replaced = input.replace_all ? count : 1;
        const drift = info.mtimeMs > seen ? " The file had changed on disk since it was read; the edit matched its current content." : "";
        return ok(`Edited ${file}: ${replaced} replacement${replaced === 1 ? "" : "s"}.${drift}`);
    }
};

// ---------------------------------------------------------------- walking

/** A glob as a regular expression over forward-slash relative paths. */
export function globToRegExp(glob: string): RegExp {
    let out = "";
    let depth = 0;
    for (let index = 0; index < glob.length; index++) {
        const char = glob[index]!;
        if (char === "*") {
            if (glob[index + 1] === "*") {
                const slash = glob[index + 2] === "/";
                out += slash ? "(?:.*/)?" : ".*";
                index += slash ? 2 : 1;
            } else out += "[^/]*";
        } else if (char === "?") out += "[^/]";
        else if (char === "{") {
            depth++;
            out += "(?:";
        } else if (char === "}" && depth > 0) {
            depth--;
            out += ")";
        } else if (char === "," && depth > 0) out += "|";
        else if (char === "[") {
            const close = glob.indexOf("]", index + 1);
            if (close > index) {
                const body = glob.slice(index + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\");
                out += `[${body}]`;
                index = close;
            } else out += "\\[";
        } else out += /[.+^$()|\\]/.test(char) ? `\\${char}` : char;
    }
    return new RegExp(`^${out}$`);
}

/** Folders a search never descends into on its own. */
const SKIPPED_DIRS = new Set([".git"]);
/** And the ones a content search also skips, standing in for .gitignore. */
const SEARCH_SKIPPED_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", "target", ".venv", "__pycache__"]);

interface Walked {
    files: { absolute: string; relative: string }[];
    truncated: boolean;
}

async function walk(ws: Workspace, base: string, skip: ReadonlySet<string>, signal: AbortSignal): Promise<Walked> {
    const files: Walked["files"] = [];
    const queue = [""];
    let seen = 0;
    while (queue.length > 0) {
        if (signal.aborted) break;
        const relative = queue.shift()!;
        let entries: Awaited<ReturnType<Workspace["list"]>>;
        try {
            entries = await ws.list(path.join(base, relative));
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (++seen > WALK_MAX_ENTRIES) return { files, truncated: true };
            const child = relative ? `${relative}/${entry.name}` : entry.name;
            if (entry.kind === "directory") {
                if (!skip.has(entry.name)) queue.push(child);
            } else if (entry.kind === "file") files.push({ absolute: path.join(base, child), relative: child });
        }
    }
    return { files, truncated: false };
}

// ---------------------------------------------------------------- Glob

const globInput = z.object({
    pattern: z.string().min(1).describe('The glob to match, such as "**/*.ts" or "src/**/*.{ts,tsx}".'),
    path: z.string().optional().describe("The folder to search in. Defaults to the current folder.")
});

export const globTool: NativeTool<z.infer<typeof globInput>> = {
    name: "Glob",
    description: [
        "Find files by name pattern, at any depth with **. Results are absolute paths, most recently modified first,",
        `capped at ${GLOB_MAX_RESULTS}. Use it to locate files; use Grep to search inside them.`
    ].join(" "),
    schema: globInput,
    gate: "none",
    writes: false,
    async run(input, { ws, state, signal }) {
        if (input.pattern.includes("\0") || input.path?.includes("\0")) return fail("Remove the null byte from the pattern or path.");
        const base = input.path ? resolvePath(state, input.path) : state.cwd;
        const info = await ws.stat(base);
        if (info?.kind !== "directory") return fail(`Not a directory: ${base}`);
        const matcher = globToRegExp(input.pattern.replace(/\\/g, "/").replace(/^\.\//, ""));
        const walked = await walk(ws, base, SKIPPED_DIRS, signal);
        const matched = walked.files.filter((file) => matcher.test(file.relative));
        const stamped = await Promise.all(
            matched.map(async (file) => ({ file: file.absolute, at: (await ws.stat(file.absolute))?.mtimeMs ?? 0 }))
        );
        stamped.sort((a, b) => b.at - a.at || a.file.localeCompare(b.file));
        if (stamped.length === 0) return ok("No files found.");
        const shown = stamped.slice(0, GLOB_MAX_RESULTS).map((entry) => entry.file);
        const notes = [
            stamped.length > GLOB_MAX_RESULTS ? `(Results are truncated: ${stamped.length} matched. Narrow the pattern.)` : "",
            walked.truncated ? `(The search stopped after ${WALK_MAX_ENTRIES} entries. Narrow the path.)` : ""
        ].filter(Boolean);
        return ok([...shown, ...notes].join("\n"));
    }
};

// ---------------------------------------------------------------- Grep

const grepInput = z.object({
    pattern: z.string().min(1).describe("The regular expression to search for (ripgrep syntax)."),
    path: z.string().optional().describe("A file or folder to search. Defaults to the current folder."),
    glob: z.string().optional().describe('Only files matching this glob, such as "*.ts".'),
    type: z.string().optional().describe('Only files of this type, such as "ts" or "py".'),
    output_mode: z.enum(["files_with_matches", "content", "count"]).optional(),
    "-i": z.boolean().optional().describe("Case-insensitive."),
    "-n": z.boolean().optional().describe("Line numbers in content mode. Defaults to true."),
    "-A": z.number().int().min(0).max(50).optional(),
    "-B": z.number().int().min(0).max(50).optional(),
    "-C": z.number().int().min(0).max(50).optional(),
    multiline: z.boolean().optional().describe("Let a match span lines."),
    head_limit: z.number().int().min(0).optional().describe(`At most this many lines or entries. Defaults to ${GREP_DEFAULT_HEAD}; 0 is unlimited.`),
    offset: z.number().int().min(0).optional()
});
type GrepInput = z.infer<typeof grepInput>;

/** File extensions per `type`, for the search without ripgrep. */
const TYPE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
    ts: ["ts", "tsx", "mts", "cts"],
    js: ["js", "jsx", "mjs", "cjs"],
    py: ["py", "pyi"],
    rust: ["rs"],
    go: ["go"],
    java: ["java"],
    json: ["json"],
    md: ["md", "markdown"],
    css: ["css", "scss", "sass", "less"],
    html: ["html", "htm"],
    yaml: ["yaml", "yml"],
    sh: ["sh", "bash"],
    c: ["c", "h"],
    cpp: ["cpp", "cc", "cxx", "hpp", "hh"],
    rb: ["rb"],
    php: ["php"],
    swift: ["swift"],
    kotlin: ["kt", "kts"]
};

function page(lines: string[], input: GrepInput): string[] {
    const head = input.head_limit ?? GREP_DEFAULT_HEAD;
    const from = input.offset ?? 0;
    return head === 0 ? lines.slice(from) : lines.slice(from, from + head);
}

async function grepWithRipgrep(input: GrepInput, base: string, ws: Workspace, signal: AbortSignal): Promise<ToolOutput> {
    const mode = input.output_mode ?? "files_with_matches";
    const args = ["rg", "--no-messages", "--color", "never"];
    if (mode === "files_with_matches") args.push("-l");
    if (mode === "count") args.push("-c");
    if (mode === "content") {
        if (input["-n"] !== false) args.push("-n");
        if (input["-C"] !== undefined) args.push("-C", String(input["-C"]));
        if (input["-A"] !== undefined) args.push("-A", String(input["-A"]));
        if (input["-B"] !== undefined) args.push("-B", String(input["-B"]));
    }
    if (input["-i"]) args.push("-i");
    if (input.multiline) args.push("-U", "--multiline-dotall");
    if (input.glob) args.push("--glob", input.glob);
    if (input.type) args.push("--type", input.type);
    args.push("-e", input.pattern, "--", base);
    const result = await ws.exec(args, { timeoutMs: 60_000, signal });
    if (result.code === 2) return fail(`ripgrep refused the search: ${result.stderr.trim() || "invalid pattern"}`);
    const lines = result.stdout.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return ok(mode === "count" ? "No matches. Total: 0" : "No files found.");
    if (mode === "count") {
        const total = lines.reduce((sum, line) => sum + (Number(line.split(":").at(-1)) || 0), 0);
        return ok([...page(lines, input), `Total: ${total}`].join("\n"));
    }
    const shown = page(lines, input);
    if (shown.length === 0) return ok("No entries at this offset.");
    return ok(shown.join("\n"));
}

async function grepBuiltIn(input: GrepInput, base: string, ws: Workspace, signal: AbortSignal): Promise<ToolOutput> {
    let regex: RegExp;
    try {
        regex = new RegExp(input.pattern, `${input["-i"] ? "i" : ""}${input.multiline ? "gs" : "g"}`);
    } catch (error) {
        return fail(`Invalid pattern: ${(error as Error).message}`);
    }
    const mode = input.output_mode ?? "files_with_matches";
    const info = await ws.stat(base);
    if (!info) return fail(`Path does not exist: ${base}`);
    const walked =
        info.kind === "file"
            ? { files: [{ absolute: base, relative: path.basename(base) }], truncated: false }
            : await walk(ws, base, SEARCH_SKIPPED_DIRS, signal);
    const globber = input.glob ? globToRegExp(input.glob.includes("/") ? input.glob : `**/${input.glob}`) : null;
    const extensions = input.type ? TYPE_EXTENSIONS[input.type] : undefined;
    if (input.type && !extensions) return fail(`Unknown file type: ${input.type}`);
    const before = input["-B"] ?? input["-C"] ?? 0;
    const after = input["-A"] ?? input["-C"] ?? 0;
    const out: string[] = [];
    let total = 0;
    for (const file of walked.files) {
        if (signal.aborted) break;
        if (globber && !globber.test(file.relative)) continue;
        if (extensions && !extensions.includes(path.extname(file.relative).slice(1))) continue;
        let buffer: Buffer;
        try {
            buffer = await ws.readFile(file.absolute);
        } catch {
            continue;
        }
        if (isBinary(buffer)) continue;
        const text = buffer.toString("utf8");
        if (mode !== "content") {
            const count = (text.match(regex) ?? []).length;
            regex.lastIndex = 0;
            if (count === 0) continue;
            total += count;
            out.push(mode === "count" ? `${file.absolute}:${count}` : file.absolute);
            continue;
        }
        const lines = text.split(/\r?\n/);
        const hits = new Set<number>();
        lines.forEach((line, index) => {
            regex.lastIndex = 0;
            if (regex.test(line)) hits.add(index);
        });
        const shown = new Set<number>();
        for (const hit of hits) for (let at = Math.max(0, hit - before); at <= Math.min(lines.length - 1, hit + after); at++) shown.add(at);
        for (const at of [...shown].sort((a, b) => a - b)) {
            const separator = hits.has(at) ? ":" : "-";
            out.push(input["-n"] === false ? `${file.absolute}${separator}${lines[at]}` : `${file.absolute}${separator}${at + 1}${separator}${lines[at]}`);
        }
    }
    if (out.length === 0) return ok(mode === "count" ? "No matches. Total: 0" : "No files found.");
    const shown = page(out, input);
    if (shown.length === 0) return ok("No entries at this offset.");
    return ok(mode === "count" ? [...shown, `Total: ${total}`].join("\n") : shown.join("\n"));
}

export const grepTool: NativeTool<GrepInput> = {
    name: "Grep",
    description: [
        "Search file contents with a regular expression (ripgrep syntax; escape braces like interface\\{\\}).",
        'output_mode "files_with_matches" (default) lists paths, "content" shows matching lines, "count" counts per file.',
        "Filter with glob or type. Prefer this to running grep or rg through Bash."
    ].join(" "),
    schema: grepInput,
    gate: "none",
    writes: false,
    async run(input, { ws, state, signal }) {
        const base = input.path ? resolvePath(state, input.path) : state.cwd;
        if (await ws.has("rg")) return grepWithRipgrep(input, base, ws, signal);
        return grepBuiltIn(input, base, ws, signal);
    }
};

/** The search without ripgrep, for the tests and a machine that lacks it. */
export const grepFallbackForTests = grepBuiltIn;

// ---------------------------------------------------------------- Bash

const bashInput = z.object({
    command: z.string().min(1).describe("The command to run."),
    timeout: z.number().int().min(1).max(BASH_MAX_TIMEOUT_MS).optional().describe(`Milliseconds, up to ${BASH_MAX_TIMEOUT_MS}. Defaults to ${BASH_DEFAULT_TIMEOUT_MS}.`),
    description: z.string().optional().describe("What the command does, in a few words."),
    run_in_background: z.boolean().optional().describe("Start it and return at once; read its output with BashOutput.")
});

const CWD_MARK = "__POLARIS_NATIVE_CWD__";

/** The shell a command runs in on this machine. */
export function shellArgv(platform: NodeJS.Platform, command: string): string[] {
    return platform === "win32" ? ["bash", "-c", command] : ["/bin/sh", "-c", command];
}

export const bashTool: NativeTool<z.infer<typeof bashInput>> = {
    name: "Bash",
    description: [
        "Run a shell command in the workspace. Each command is its own process: environment changes do not carry over,",
        "but a cd inside the project does. Quote paths with spaces.",
        `Default timeout ${BASH_DEFAULT_TIMEOUT_MS / 60_000} minutes, up to ${BASH_MAX_TIMEOUT_MS / 60_000}.`,
        "Use run_in_background for servers, watchers and long builds, then BashOutput to read them.",
        "Use Read, Edit, Write, Glob and Grep instead of cat, sed, echo, find and grep. Use git and gh for version control and pull requests."
    ].join(" "),
    schema: bashInput,
    gate: "shell",
    writes: true,
    async run(input, { ws, state, signal }) {
        if (input.run_in_background) {
            const id = `shell_${state.nextShell++}`;
            const proc = ws.spawnBackground(shellArgv(ws.platform, input.command), { cwd: state.cwd });
            state.shells.set(id, { command: input.command, process: proc, readAt: 0 });
            return ok(`Started in the background with id ${id}. Read its output with BashOutput.`);
        }
        // Git Bash on Windows reports /c/... in $PWD; `pwd -W` gives C:/...
        const where = ws.platform === "win32" ? "$(pwd -W 2>/dev/null || pwd)" : "$PWD";
        const wrapped = `${input.command}\n__polaris_status=$?\nprintf '\\n${CWD_MARK}%s' "${where}"\nexit $__polaris_status`;
        const result = await ws.exec(shellArgv(ws.platform, wrapped), {
            cwd: state.cwd,
            timeoutMs: input.timeout ?? BASH_DEFAULT_TIMEOUT_MS,
            signal
        });
        let stdout = result.stdout;
        const mark = stdout.lastIndexOf(CWD_MARK);
        let note = "";
        if (mark >= 0) {
            const reported = stdout.slice(mark + CWD_MARK.length).trim();
            stdout = stdout.slice(0, mark).trimEnd();
            const next = reported ? path.resolve(reported) : state.cwd;
            if (inside(ws.root, next)) state.cwd = next;
            else {
                state.cwd = ws.root;
                note = `\nShell cwd was reset to ${ws.root}`;
            }
        }
        const body = [stdout, result.stderr].filter((part) => part.trim() !== "").join("\n");
        const clipped = clipMiddle(body, BASH_MAX_OUTPUT_CHARS);
        if (result.timedOut) return fail(`${clipped}\nCommand timed out after ${input.timeout ?? BASH_DEFAULT_TIMEOUT_MS} ms.${note}`.trim());
        if (result.aborted) return fail(`${clipped}\nCommand was interrupted.`.trim());
        if (result.code !== 0) return fail(`${clipped}\nExit code ${result.code}${note}`.trim());
        return ok((clipped || "(no output)") + note);
    }
};

const bashOutputInput = z.object({
    bash_id: z.string().min(1).describe("The id Bash returned for a background command."),
    filter: z.string().optional().describe("Only lines matching this regular expression.")
});

export const bashOutputTool: NativeTool<z.infer<typeof bashOutputInput>> = {
    name: "BashOutput",
    description: "Read the new output of a background command since the last read, and whether it is still running.",
    schema: bashOutputInput,
    gate: "none",
    writes: false,
    async run(input, { state }) {
        const job = state.shells.get(input.bash_id);
        if (!job) return fail(`No background command with id ${input.bash_id}.`);
        const all = job.process.output();
        let fresh = all.slice(job.readAt);
        job.readAt = all.length;
        if (input.filter) {
            let regex: RegExp;
            try {
                regex = new RegExp(input.filter);
            } catch (error) {
                return fail(`Invalid filter: ${(error as Error).message}`);
            }
            fresh = fresh.split(/\r?\n/).filter((line) => regex.test(line)).join("\n");
        }
        const status = job.process.running() ? "running" : `exited with code ${job.process.exitCode()}`;
        return ok(`<status>${status}</status>\n${clipMiddle(fresh, BASH_MAX_OUTPUT_CHARS) || "(no new output)"}`);
    }
};

const killInput = z.object({ shell_id: z.string().min(1).describe("The id of the background command to stop.") });

export const killShellTool: NativeTool<z.infer<typeof killInput>> = {
    name: "KillShell",
    description: "Stop a background command by its id.",
    schema: killInput,
    gate: "none",
    writes: false,
    async run(input, { state }) {
        const job = state.shells.get(input.shell_id);
        if (!job) return fail(`No background command with id ${input.shell_id}.`);
        job.process.kill();
        state.shells.delete(input.shell_id);
        return ok(`Stopped ${input.shell_id}.`);
    }
};

// ---------------------------------------------------------------- TodoWrite

const todoInput = z.object({
    todos: z
        .array(
            z.object({
                content: z.string().trim().min(1).max(500),
                status: z.enum(["pending", "in_progress", "completed"]),
                activeForm: z.string().trim().min(1).max(500)
            })
        )
        .max(100)
});

export const todoWriteTool: NativeTool<z.infer<typeof todoInput>> = {
    name: "TodoWrite",
    description: [
        "Keep the session's task list, shown live to the user. Use it for work with three or more steps or when asked.",
        "Send the whole list each time. Exactly one item in_progress at a time; mark an item completed as soon as it is done,",
        "and only when it is fully done and verified. content is the imperative (\"Run the tests\"), activeForm the progressive (\"Running the tests\")."
    ].join(" "),
    schema: todoInput,
    gate: "none",
    writes: false,
    async run(input, { state }) {
        state.todos = input.todos;
        const open = input.todos.filter((todo) => todo.status !== "completed").length;
        return ok(`The task list is saved: ${input.todos.length} items, ${open} open. Keep it current as you work.`);
    }
};

// ---------------------------------------------------------------- asks

const questionInput = z.object({
    question: z.string().trim().min(1).max(500),
    header: z.string().trim().max(60).optional(),
    multiSelect: z.boolean().optional(),
    options: z.array(z.object({ label: z.string().trim().min(1).max(200), description: z.string().max(500).optional() })).min(1).max(8)
});
const askInput = z.object({ questions: z.array(questionInput).min(1).max(4) });

export const askUserQuestionTool: NativeTool<z.infer<typeof askInput>> = {
    name: "AskUserQuestion",
    description: [
        "Ask the user one to four multiple-choice questions when a decision is genuinely theirs or a requirement is ambiguous.",
        "Each question has 2-8 options with a short label; the user can also type their own answer.",
        "Do not ask what you can find out by reading the code."
    ].join(" "),
    schema: askInput,
    gate: "ask",
    writes: false,
    async run(input, { answer }) {
        const answers = (answer?.answers ?? {}) as Record<string, string>;
        const lines = input.questions.map((q) => `"${q.question}" = "${answers[q.question] ?? "(no answer)"}"`);
        return ok(`The user answered:\n${lines.join("\n")}\nCarry on with these answers.`);
    }
};

const planInput = z.object({ plan: z.string().trim().min(1).max(50_000).describe("The plan, in Markdown.") });

export const exitPlanModeTool: NativeTool<z.infer<typeof planInput>> = {
    name: "ExitPlanMode",
    description: "In plan mode, present the finished plan for the user's approval. When approved, you may start changing files.",
    schema: planInput,
    gate: "ask",
    writes: false,
    async run(_input, { state }) {
        state.mode = "default";
        return ok("The user approved the plan. Start working on it now, keeping the task list current.");
    }
};

// ---------------------------------------------------------------- Task

const taskInput = z.object({
    description: z.string().trim().min(1).max(120).describe("Three to five words on what it does."),
    prompt: z.string().trim().min(1).max(100_000).describe("The whole task: the child sees nothing else."),
    subagent_type: z.enum(["general-purpose", "Explore"]).optional().describe("Explore is read-only and fast; general-purpose can change files.")
});
export type TaskInput = z.infer<typeof taskInput>;

export const taskTool: NativeTool<TaskInput> = {
    name: "Task",
    description: [
        "Hand a self-contained task to a subagent with its own context, and get back only its report.",
        "Use Explore for broad searches across many files; general-purpose for independent multi-step work.",
        "Start several in one reply to run them in parallel. Brief it fully: it knows only the prompt you give it."
    ].join(" "),
    schema: taskInput,
    gate: "none",
    writes: false,
    async run(input, { subagent, signal }) {
        if (!subagent) return fail("A subagent cannot start another subagent.");
        return ok(await subagent(input, signal));
    }
};

// ---------------------------------------------------------------- sets

export const NATIVE_TOOLS: readonly NativeTool<never>[] = [
    readTool,
    writeTool,
    editTool,
    globTool,
    grepTool,
    bashTool,
    bashOutputTool,
    killShellTool,
    todoWriteTool,
    askUserQuestionTool,
    exitPlanModeTool,
    taskTool
] as unknown as readonly NativeTool<never>[];

/** The tools a subagent gets: never the asks, never another Task, and only
 *  the read-only ones for Explore. */
export function subagentTools(type: TaskInput["subagent_type"]): readonly NativeTool<never>[] {
    const readOnly = new Set(["Read", "Glob", "Grep", "Bash", "BashOutput"]);
    return NATIVE_TOOLS.filter((entry) => {
        if (entry.gate === "ask" || entry.name === "Task" || entry.name === "TodoWrite") return false;
        return type === "Explore" ? readOnly.has(entry.name) : true;
    });
}
