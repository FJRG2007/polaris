/**
 * Code's own "/" commands: the ones Polaris runs itself (a new task, the
 * history, stopping a turn) and the ones handed to the agent's own CLI, spelled
 * the way that CLI spells them.
 *
 * Handed over only where the CLI has the command and it finishes without a
 * picker of its own to answer: Claude Code's /clear, /compact, /review,
 * /security-review, /init, /plan and /simplify
 * (https://code.claude.com/docs/en/commands),
 * Codex's /new, /compact and /init
 * (https://developers.openai.com/codex/cli/slash-commands), opencode's /new,
 * /compact and /init (https://opencode.ai/docs/tui/) and Gemini CLI's /clear
 * and /compress. Commands that open a picker inside the terminal (/model,
 * /resume, /config, Codex's /review) are left out: nothing here can answer
 * that picker. Only Claude Code takes words after a command; the others are
 * sent the bare name. /context and /export are Polaris's own: they read what
 * the session reported and its stored transcript, for every CLI.
 *
 * Polaris runs /goal itself for every CLI, the way Polar's chat does
 * (`lib/agents/session-goal.ts`), plus /copy and /exit. The full inventory
 * and why each other command is or is not here is in
 * `docs/polar-claude-code-parity.md` (section 8).
 *
 * Client-safe: no server imports.
 */

import * as polarSlash from "@/lib/polar/slash";

export const CODE_COMMANDS = [
    "help",
    "new",
    "resume",
    "model",
    "clear",
    "compact",
    "review",
    "security-review",
    "init",
    "stop",
    "rename",
    "diff",
    "context",
    "export",
    "goal",
    "plan",
    "simplify",
    "copy",
    "exit"
] as const;
export type CodeCommand = (typeof CODE_COMMANDS)[number];

/** Where a command is typed: the composer that starts a task, or a running
 *  session's reply box. */
export type CodeCommandPlace = "start" | "thread";

type Forwarded = "clear" | "compact" | "review" | "security-review" | "init" | "plan" | "simplify";

/** Each CLI's spelling of a command Code hands over, by the CLI's id
 *  (`AGENT_CLIS` in `@polaris/core`). A CLI missing from a row lacks it. */
const FORWARDED: Record<Forwarded, Readonly<Record<string, string>>> = {
    clear: { claude: "clear", codex: "new", opencode: "new", gemini: "clear" },
    compact: { claude: "compact", codex: "compact", opencode: "compact", gemini: "compress" },
    review: { claude: "review" },
    "security-review": { claude: "security-review" },
    init: { claude: "init", codex: "init", opencode: "init" },
    plan: { claude: "plan" },
    simplify: { claude: "simplify" }
};

/** Polaris's own commands, by where each applies. */
const LOCAL: Record<Exclude<CodeCommand, Forwarded>, readonly CodeCommandPlace[]> = {
    help: ["start", "thread"],
    new: ["thread"],
    resume: ["start", "thread"],
    model: ["start"],
    stop: ["thread"],
    rename: ["thread"],
    diff: ["thread"],
    context: ["thread"],
    export: ["thread"],
    goal: ["thread"],
    copy: ["thread"],
    exit: ["thread"]
};

/** Commands whose words after them matter, so picking one from the list
 *  puts it in the box instead of running it. */
const TAKES_TEXT = new Set<CodeCommand>(["compact", "review", "rename", "goal", "plan", "simplify"]);

export function takesText(command: CodeCommand): boolean {
    return TAKES_TEXT.has(command);
}

function isForwarded(command: CodeCommand): command is Forwarded {
    return command in FORWARDED;
}

/**
 * The commands on offer in a place, in the list's order. In a session the
 * handed-over ones follow the CLI it runs; at the start, /clear empties the
 * composer instead, since there is no conversation yet to clear.
 */
export function codeCommandsFor(place: CodeCommandPlace, cli: string | null): CodeCommand[] {
    return CODE_COMMANDS.filter((command) => {
        if (place === "start")
            return command === "clear" || (!isForwarded(command) && LOCAL[command].includes("start"));
        if (isForwarded(command)) return cli !== null && cli in FORWARDED[command];
        return LOCAL[command].includes("thread");
    });
}

/** The commands that match what was typed after the "/", best first. */
export function matchCodeCommands(input: string, available: readonly CodeCommand[]): CodeCommand[] {
    const query = polarSlash.slashQuery(input);
    if (query === null) return [];
    return polarSlash.rankedByShortcut(available, (command) => command, query);
}

/** A command typed whole at the start of the message, with what follows its
 *  name; null for any other text or one not on offer here. */
export function codeCommandIn(
    raw: string,
    available: readonly CodeCommand[]
): { command: CodeCommand; rest: string } | null {
    const found = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/i.exec(raw.trim());
    const name = found?.[1]?.toLowerCase();
    const command = available.find((entry) => entry === name);
    return command ? { command, rest: (found?.[2] ?? "").trim() } : null;
}

/** What is sent to the session for a handed-over command, in the CLI's own
 *  spelling; null for a command Polaris runs itself or one the CLI lacks. */
export function forwardedText(command: CodeCommand, rest: string, cli: string): string | null {
    if (!isForwarded(command)) return null;
    const name = FORWARDED[command][cli];
    if (!name) return null;
    return rest && cli === "claude" && TAKES_TEXT.has(command) ? `/${name} ${rest}` : `/${name}`;
}

/** Which answer `/copy [N]` copies: 1 for the newest, null for words that are
 *  not a whole number from 1 up. */
export function copyIndex(rest: string): number | null {
    if (!rest.trim()) return 1;
    const found = /^\d{1,4}$/.exec(rest.trim());
    const index = found ? Number(found[0]) : 0;
    return index >= 1 ? index : null;
}
