/**
 * The commands a session is made of.
 *
 * Everything here is a pure builder, and that is the point: none of it can be
 * exercised on a machine without Docker, an enrolled server and somebody's
 * repository, so what it produces has to be assertable on its own. The parts that
 * actually touch a machine live in `session-runtime.ts` and do nothing but hand
 * these strings over.
 *
 * A session is a tmux session, wherever it runs.
 *
 * That is the one decision the rest follows from. Polaris is a web control plane:
 * there is no long-lived process here holding a pseudo-terminal open, and there
 * cannot be - the dashboard restarts, and a session that died with it would be
 * useless. tmux is a program whose entire job is to hold a terminal open for
 * something that comes and goes, and it gives three things at once:
 *
 *   - Steering. `send-keys` and `paste-buffer` put a prompt into the agent's own
 *     terminal, which is how a person would have done it.
 *   - Watching. `attach` gives the browser the live terminal, and detaching does
 *     not stop the agent.
 *   - Survival. The agent keeps working while nobody is looking at it, which is
 *     the whole reason to run one somewhere other than your laptop.
 *
 * The same three commands work over `docker exec` into a container and over SSH
 * to an enrolled server, so there is one steering path rather than two.
 */

import { shellQuote } from "./session-hooks";
import { promptSubmitDelayMs, sanitizeAgentPrompt } from "@polaris/core";

/** The tmux session every agent runs in, inside its own container or its own
 *  directory on a server. Fixed rather than derived: there is one agent per
 *  place, and a name nobody has to look up is a name that stays right. */
export const TMUX_SESSION = "polaris-agent";

/** The terminal the agent thinks it has. Wide enough that the tools that draw
 *  boxes draw them, and fixed so what Polaris captures matches what a person
 *  attaching sees. */
export const TMUX_COLS = 200;
export const TMUX_ROWS = 50;

/**
 * The image a `local` session runs in.
 *
 * The full Node image rather than a slim one for the same reason a run uses it:
 * the agent clones with git, installs itself with npm, and fetches things with
 * curl, and an image missing any of those turns into an apt-get on every session.
 */
export const SESSION_IMAGE = "node:24";

/** The compose project, and therefore the container, one session gets. */
export function sessionContainerName(sessionId: string): string {
    return `polaris-session-${sessionId}`;
}

// ---------------------------------------------------------------------------
// Bringing a session up
// ---------------------------------------------------------------------------

/**
 * What a `local` session's container does when it starts.
 *
 * Fixed rather than assembled, exactly as a run's is: nothing from a repository
 * name, a branch, a prompt or an operator's own settings is interpolated into a
 * shell here. Every value it needs arrives in the environment, where a command
 * line's readability by anything that can list processes does not apply.
 *
 * It ends by parking rather than exiting. The container's job is to be somewhere
 * a tmux session can live; the agent inside it comes and goes, and a container
 * that stopped when the first agent exited would take the worktree, the branch
 * and the uncommitted work with it.
 */
export const SESSION_BOOT = [
    "set -eu",
    // tmux is what holds the agent's terminal open, and the Node image does not
    // carry it. One install per session, on a layer nothing caches - the honest
    // cost of not shipping an image of our own.
    "if ! command -v tmux >/dev/null 2>&1; then",
    "  apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq tmux >/dev/null 2>&1 || true",
    "fi",
    'command -v tmux >/dev/null 2>&1 || { echo "polaris: this machine has no tmux and one could not be installed"; exit 1; }',
    // The credential goes to git as a config value read from the environment,
    // never as part of the URL - which would put it in the reflog and in every
    // error message git prints.
    'git clone --depth 50 -c http.extraHeader="$GIT_AUTH_HEADER" "https://github.com/$GITHUB_REPOSITORY.git" "$POLARIS_WORKDIR"',
    'cd "$POLARIS_WORKDIR"',
    'git checkout -b "$POLARIS_BRANCH"',
    // The agent reports what it is doing through a script Polaris registers in
    // the agent's own configuration. Written from the environment so neither the
    // URL nor the token is ever an argument.
    //
    // Into the WORKTREE rather than into the home directory, and that is the
    // whole reason a session on somebody's own server is usable at all: the
    // machine's `~/.claude` holds their login and their settings, and a Polaris
    // that wrote its hooks there would be hijacking every agent that person ever
    // starts. A project-local settings file applies to this worktree and to
    // nothing else, and is excluded from git so the agent cannot commit it.
    'mkdir -p "$POLARIS_WORKDIR/.claude"',
    'printf %s "$POLARIS_HOOK_SCRIPT" > "$POLARIS_WORKDIR/.claude/polaris-hook.sh"',
    'chmod +x "$POLARIS_WORKDIR/.claude/polaris-hook.sh"',
    'printf %s "$POLARIS_HOOK_SETTINGS" > "$POLARIS_WORKDIR/.claude/settings.local.json"',
    'printf "%s\n" ".claude/" >> "$POLARIS_WORKDIR/.git/info/exclude"',
    // Enigma, when the resolved settings asked for it. Best effort: a session
    // without it works to weaker standards, and failing the whole thing over a
    // network blip would be worse than that.
    '[ -n "$POLARIS_ENIGMA_ARGV" ] && npx $POLARIS_ENIGMA_ARGV >/dev/null 2>&1 || true',
    // The agent itself. Also best effort - the check below is what decides.
    '[ -n "$POLARIS_AGENT_INSTALL" ] && sh -c "$POLARIS_AGENT_INSTALL" >/dev/null 2>&1 || true',
    'command -v "$POLARIS_AGENT_BINARY" >/dev/null 2>&1 || { echo "polaris: $POLARIS_AGENT_BINARY is not installed and could not be installed here"; exit 1; }',
    // The clone is done, so the credential that did it goes before the agent
    // starts and can read its own environment. The token the agent's own git and
    // GitHub tools need stays.
    "unset GIT_AUTH_HEADER",
    "unset POLARIS_HOOK_SCRIPT POLARIS_HOOK_SETTINGS",
    'tmux new-session -d -s "$POLARIS_TMUX" -x "$POLARIS_COLS" -y "$POLARIS_ROWS" -c "$POLARIS_WORKDIR" "$POLARIS_AGENT_COMMAND"',
    // Park. See above: the container outlives the agent inside it.
    "exec tail -f /dev/null"
].join("\n");

// ---------------------------------------------------------------------------
// Steering
// ---------------------------------------------------------------------------

/**
 * The shell command that puts a prompt into a running agent's terminal.
 *
 * Through tmux's paste buffer rather than as keystrokes. `paste-buffer -p` wraps
 * the text in the terminal's bracketed-paste markers, which is what tells a
 * full-screen program that a newline in the middle of it is text rather than the
 * Enter key - the difference between sending a paragraph and sending its first
 * line three times.
 *
 * The prompt is sanitised before it gets here and quoted on the way out. Both are
 * needed and neither is enough alone: quoting stops the shell interpreting it,
 * and sanitising stops the TERMINAL interpreting it, which is the one that
 * matters when the text came from an issue somebody else wrote.
 */
export function pastePromptCommand(text: string, session = TMUX_SESSION): string {
    const safe = sanitizeAgentPrompt(text);
    const buffer = "polaris-prompt";
    return [
        `tmux set-buffer -b ${buffer} -- ${shellQuote(safe)}`,
        `tmux paste-buffer -p -d -b ${buffer} -t ${shellQuote(session)}`
    ].join(" && ");
}

/** The command that submits what was pasted. Separate because it is sent after a
 *  wait: the paste has to have been ingested before a newline means "send that",
 *  and how long that takes is a property of the transport. */
export function submitCommand(session = TMUX_SESSION): string {
    return `tmux send-keys -t ${shellQuote(session)} Enter`;
}

/** How long to leave between the two, for a prompt of this size. */
export function submitDelayMs(text: string): number {
    return promptSubmitDelayMs(Buffer.byteLength(sanitizeAgentPrompt(text), "utf8"));
}

/**
 * Stop what the agent is doing without stopping the agent.
 *
 * Escape rather than Ctrl-C. Every one of these tools treats Escape as "stop this
 * turn" and Ctrl-C as "quit", and a person who meant the first and got the second
 * loses the conversation, the context and whatever was uncommitted.
 */
export function interruptCommand(session = TMUX_SESSION): string {
    return `tmux send-keys -t ${shellQuote(session)} Escape`;
}

/** What the agent's terminal currently shows, as text. For the list, which wants
 *  a line of context per session without opening a terminal to each one. */
export function captureCommand(lines = 200, session = TMUX_SESSION): string {
    return `tmux capture-pane -p -t ${shellQuote(session)} -S -${Math.max(1, Math.floor(lines))}`;
}

/** Whether the agent is still running in there. A tmux session outlives the
 *  program it started, so "the container is up" is not the same question. */
export function aliveCommand(session = TMUX_SESSION): string {
    return `tmux has-session -t ${shellQuote(session)}`;
}

/**
 * The argv that attaches a terminal to the session.
 *
 * Returned as an argument vector rather than a command line because this is what
 * is handed to the daemon's exec, which takes one - and because attaching is the
 * path a person's keystrokes travel, where an extra shell between them and the
 * agent is one more thing to get the quoting wrong.
 */
export function attachArgv(session = TMUX_SESSION): string[] {
    return ["tmux", "attach-session", "-t", session];
}

/** The argv that runs one of the commands above through a shell on the machine. */
export function shellArgv(command: string): string[] {
    return ["sh", "-c", command];
}
