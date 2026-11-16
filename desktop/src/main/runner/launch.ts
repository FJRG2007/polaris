/**
 * How a `session.start` becomes programs on this computer: where the work
 * lives, the git steps that put it there, and the agent CLI's argument list.
 *
 * Everything here is pure and answers argument arrays: nothing is ever handed
 * to a shell, and every value from the server that lands on a command line
 * (a branch, a ref, a model) is checked first or placed after `--`.
 */

import { join, posix, resolve, sep, win32 } from "node:path";
import * as clis from "../../../../dashboard/packages/core/src/agent-clis";
import { hookGroup } from "../../../../dashboard/packages/core/src/agent-hook-files";
import type * as protocol from "../../../../dashboard/packages/core/src/runner-protocol";

/** The custom CLI's id: a command the person typed rather than a known tool. */
export const CUSTOM_CLI = clis.CUSTOM_AGENT_CLI;

export type SessionStart = protocol.ServerMessage & { type: "session.start"; };

/** A git ref name that is safe as an argument: what `git check-ref-format`
 *  accepts for a branch, minus a leading dash so it can never read as an
 *  option. */
export function safeRef(ref: string): boolean {
    return (
        ref.length > 0 &&
        ref.length <= 250 &&
        /^[A-Za-z0-9._/-]+$/.test(ref) &&
        !ref.startsWith("-") &&
        !ref.startsWith("/") &&
        !ref.endsWith("/") &&
        !ref.endsWith(".") &&
        !ref.endsWith(".lock") &&
        !ref.includes("..") &&
        !ref.includes("//")
    );
}

/** `owner/name` as one folder name. */
export function repoFolder(fullName: string): string | null {
    const match = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/.exec(fullName);
    if (!match || match[1]!.startsWith(".") || match[2]!.startsWith(".")) return null;
    return `${match[1]}__${match[2]}`;
}

/** Whether `child` is `parent` or inside it. */
export function inside(parent: string, child: string): boolean {
    const a = resolve(parent);
    const b = resolve(child);
    return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep);
}

export interface Workspace {
    /** Where the agent runs. */
    readonly workdir: string;
    /** git runs, in order, each `{ cwd, args }`. */
    readonly steps: readonly { cwd: string; args: string[]; }[];
    /** Folders to create first. */
    readonly folders: readonly string[];
}

export type WorkspaceAnswer = { ok: true; workspace: Workspace; } | { ok: false; reason: "branch" | "repository" | "path"; };

/**
 * Where a session works and the git steps that get it there.
 *
 * - `clone`: one shared clone per repository under `<root>/repos`, fetched
 *   again on every start, and a worktree per session under `<root>/sessions`
 *   on the session's branch, made from `origin/<baseRef>`.
 * - `path`: the folder the person picked, which must be one of `allowed`; the
 *   agent works there as it is.
 * - `none`: an empty folder of its own under `<root>/sessions`.
 *
 * `cloneExists` says whether the shared clone is already there.
 */
export function planWorkspace(start: SessionStart, root: string, allowed: readonly string[], cloneExists: (dir: string) => boolean): WorkspaceAnswer {
    const sessionDir = join(root, "sessions", start.sessionId);
    const repository = start.repository;
    if (repository.kind === "none") return { ok: true, workspace: { workdir: sessionDir, steps: [], folders: [sessionDir] } };
    if (repository.kind === "path") {
        if (!allowed.some((folder) => inside(folder, repository.path))) return { ok: false, reason: "path" };
        return { ok: true, workspace: { workdir: resolve(repository.path), steps: [], folders: [] } };
    }
    const folder = repoFolder(repository.fullName);
    if (!folder) return { ok: false, reason: "repository" };
    if (!safeRef(start.branch) || !safeRef(start.baseRef)) return { ok: false, reason: "branch" };
    const clone = join(root, "repos", folder);
    const steps: { cwd: string; args: string[]; }[] = cloneExists(clone)
        ? [{ cwd: clone, args: ["fetch", "--prune", "origin"] }]
        : [{ cwd: join(root, "repos"), args: ["clone", "--no-checkout", "--", repository.url, clone] }];
    steps.push({ cwd: clone, args: ["worktree", "prune"] });
    steps.push({ cwd: clone, args: ["worktree", "add", "-B", start.branch, sessionDir, `origin/${start.baseRef}`] });
    return { ok: true, workspace: { workdir: sessionDir, steps, folders: [join(root, "repos"), join(root, "sessions")] } };
}

/**
 * The command words of a custom CLI, split the way a POSIX shell splits
 * words: whitespace separates, single quotes keep everything, double quotes
 * keep everything but a backslash before `"` or `\`. Nothing is expanded.
 * Null for an unterminated quote.
 */
export function splitCommand(command: string): string[] | null {
    const words: string[] = [];
    let word = "";
    let started = false;
    let quote: "'" | '"' | null = null;
    for (let index = 0; index < command.length; index++) {
        const char = command[index]!;
        if (quote === "'") {
            if (char === "'") quote = null;
            else word += char;
        } else if (quote === '"') {
            if (char === '"') quote = null;
            else if (char === "\\" && (command[index + 1] === '"' || command[index + 1] === "\\")) word += command[++index];
            else word += char;
        } else if (char === "'" || char === '"') {
            quote = char;
            started = true;
        } else if (/\s/.test(char)) {
            if (started) words.push(word);
            word = "";
            started = false;
        } else {
            word += char;
            started = true;
        }
    }
    if (quote) return null;
    if (started) words.push(word);
    return words;
}

/** A command found on `PATH`, as a full path. On Windows `PATHEXT` is tried,
 *  so an npm shim (`claude.cmd`) is found by its bare name. */
export function findOnPath(name: string, env: Record<string, string>, platform: string, exists: (file: string) => boolean): string | null {
    if (name.includes("/") || name.includes("\\")) return exists(name) ? name : null;
    const win = platform === "win32";
    const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
    const exts = win ? ["", ...(env.PATHEXT ?? env.Pathext ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((ext) => ext.toLowerCase())] : [""];
    for (const dir of pathValue.split(win ? ";" : ":")) {
        if (!dir) continue;
        for (const ext of exts) {
            // A bare name with no extension is not runnable on Windows.
            if (win && ext === "") continue;
            const file = (win ? win32 : posix).join(dir, name + ext);
            if (exists(file)) return file;
        }
    }
    return null;
}

/**
 * The events Claude Code reports, as `claudeHookSettings` in
 * `apps/web/src/lib/agents/session-hooks.ts` registers them for a container
 * session. Kept in step with that list by hand.
 */
const CLAUDE_HOOK_EVENTS: readonly { event: string; matcher: string | null; }[] = [
    { event: "SessionStart", matcher: null },
    { event: "UserPromptSubmit", matcher: null },
    { event: "PreToolUse", matcher: "*" },
    { event: "PostToolUse", matcher: "*" },
    { event: "PermissionRequest", matcher: "*" },
    { event: "Notification", matcher: null },
    { event: "Stop", matcher: null },
    { event: "StopFailure", matcher: null },
    { event: "SubagentStart", matcher: null },
    { event: "SubagentStop", matcher: null },
    { event: "PostCompact", matcher: null },
    { event: "SessionEnd", matcher: null }
];

/**
 * The hook every event runs, the container's `hookScript` without a script
 * file: the managed Node (first on the session's PATH) reads the event on
 * standard input, posts it to the session's report URL, and for a permission
 * prompt or a question waits for the answer from the permission URL beside
 * it and prints that. The URL and token come from the session's environment
 * (`POLARIS_REPORT_URL`, `POLARIS_REPORT_TOKEN`), so the settings file holds
 * no secret. The program has no `$`, backtick, backslash or double quote, so
 * the same words mean the same thing to every shell Claude Code may use.
 */
export const HOOK_RELAY_PROGRAM = [
    "const u=process.env.POLARIS_REPORT_URL||'',t=process.env.POLARIS_REPORT_TOKEN||'';let b='';",
    "process.stdin.setEncoding('utf8');process.stdin.on('data',(c)=>{b+=c});process.stdin.on('end',async()=>{",
    "const h={'Authorization':'Bearer '+t,'Content-Type':'application/json','X-Polaris-Seq':String(BigInt(Date.now())*1000000n)};let a='';",
    "if(u){try{await fetch(u,{method:'POST',headers:h,body:b,signal:AbortSignal.timeout(4000)})}catch{}",
    "try{const p=JSON.parse(b);const n=p.hook_event_name;",
    "if(n==='PermissionRequest'||(n==='PreToolUse'&&['AskUserQuestion','ExitPlanMode'].includes(p.tool_name))){",
    "const r=await fetch(u.slice(0,u.lastIndexOf('/'))+'/permission',{method:'POST',headers:h,body:b,signal:AbortSignal.timeout(125000)});",
    "if(r.ok)a=(await r.text()).trim()}}catch{}}",
    "process.stdout.write(a||'{}')})"
].join("");

/** How long Claude Code waits on a hook, the container session's values
 *  (`HOOK_TIMEOUT_SECONDS`, `PERMISSION_HOOK_TIMEOUT_SECONDS`). */
const HOOK_TIMEOUT_SECONDS = 5;
const PERMISSION_HOOK_TIMEOUT_SECONDS = 130;

/** The `--settings` file for a Claude Code session on this computer. */
export function claudeRunnerSettings(): Record<string, unknown> {
    const command = `node -e "${HOOK_RELAY_PROGRAM}"`;
    const hooks: Record<string, unknown[]> = {};
    for (const { event, matcher } of CLAUDE_HOOK_EVENTS) {
        const timeout = event === "PermissionRequest" || event === "PreToolUse" ? PERMISSION_HOOK_TIMEOUT_SECONDS : HOOK_TIMEOUT_SECONDS;
        hooks[event] = [hookGroup(command, timeout, { matcher })];
    }
    return { hooks, skipDangerousModePermissionPrompt: true };
}

export type LaunchAnswer = { ok: true; command: string; args: string[]; env: Record<string, string>; } | { ok: false; reason: "command" | "missing"; };

/**
 * The agent CLI's program, arguments and environment. `settingsFile` is where
 * `claudeRunnerSettings` was written, for Claude Code.
 */
export function cliLaunch(
    start: SessionStart,
    env: Record<string, string>,
    platform: string,
    exists: (file: string) => boolean,
    settingsFile: string
): LaunchAnswer {
    let words: string[];
    if (start.cli === clis.CUSTOM_AGENT_CLI) {
        const split = start.command ? splitCommand(start.command) : null;
        if (!split || split.length === 0) return { ok: false, reason: "command" };
        words = split;
    } else {
        const cli = clis.agentCliById(start.cli);
        if (!cli) return { ok: false, reason: "missing" };
        const binary = cli.binaries.find((name) => findOnPath(name, env, platform, exists)) ?? cli.binaries[0];
        if (!binary) return { ok: false, reason: "missing" };
        words = [
            binary,
            ...clis.agentModelArgs(start.cli, start.model),
            ...clis.agentEffortArgs(start.cli, start.effort),
            ...(clis.permissionModeArgs(start.cli, start.permissionMode) ?? []),
            ...(start.cli === "claude" ? ["--settings", settingsFile] : [])
        ];
    }
    const command = findOnPath(words[0]!, env, platform, exists);
    if (!command) return { ok: false, reason: "missing" };
    return {
        ok: true,
        command,
        args: words.slice(1),
        env: {
            ...env,
            ...clis.agentModelEnv(start.cli, start.model),
            TERM: "xterm-256color",
            COLORTERM: "truecolor",
            POLARIS_SESSION_ID: start.sessionId,
            POLARIS_REPORT_URL: start.report.url,
            POLARIS_REPORT_TOKEN: start.report.token
        }
    };
}

/** What typing a prompt into the agent's terminal is: a bracketed paste, so a
 *  prompt with newlines arrives as one message, then Enter. */
export function promptKeys(text: string): string {
    return `\u001b[200~${text.replace(/\u001b\[20[01]~/g, "")}\u001b[201~\r`;
}

/** The key that interrupts the agent: Escape for Claude Code, which stops the
 *  turn and keeps the session, Ctrl+C for the rest. */
export function interruptKey(cli: string): string {
    return cli === "claude" ? "\u001b" : "\u0003";
}
