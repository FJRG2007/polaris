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
 * The terminal a SIGN-IN gets, which is a narrower one on purpose.
 *
 * A session's terminal is read by somebody who chose to open a terminal, and
 * width is what makes a coding agent's tables and diffs legible. A sign-in is
 * read by somebody who has never wanted to see one: it is four lines of
 * instructions and a URL, shown inside a dialog. Two hundred columns in there is
 * a horizontal scrollbar under every line, and every line is mostly empty.
 *
 * Eighty is the width every one of these tools is drawn to fall back to, so what
 * it prints at this size is a layout its vendor tested rather than one nobody
 * has seen.
 */
export const SIGNIN_COLS = 80;
export const SIGNIN_ROWS = 30;

/**
 * The image a `local` session runs in.
 *
 * The full Node image rather than a slim one for the same reason a run uses it:
 * the agent clones with git, installs itself with npm, and fetches things with
 * curl, and an image missing any of those turns into an apt-get on every session.
 */
export const SESSION_IMAGE = "node:24";

/** The unprivileged account the agent runs as in that image, which ships it.
 *  Not root, because these tools refuse their skip-permissions flag as root -
 *  see `START_AGENT`. It is given passwordless sudo, so nothing it could reach
 *  before is out of reach now. */
export const CONTAINER_USER = "node";

/** The compose project, and therefore the container, one session gets. */
export function sessionContainerName(sessionId: string): string {
    return `polaris-session-${sessionId}`;
}

// ---------------------------------------------------------------------------
// Bringing a session up
// ---------------------------------------------------------------------------

/** Making tmux available where Polaris owns the machine. The Node image does not
 *  carry it, and one install per session on a layer nothing caches is the honest
 *  cost of not shipping an image of our own. */
const INSTALL_TMUX = [
    "if ! command -v tmux >/dev/null 2>&1; then",
    "  apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq tmux >/dev/null 2>&1 || true",
    "fi"
];

/** No tmux, no session. Said plainly, because on a server that is the whole
 *  answer: Polaris does not reach for a package manager it was never given. */
const REQUIRE_TMUX = [
    'command -v tmux >/dev/null 2>&1 || { echo "polaris: this machine has no tmux and one could not be installed"; exit 1; }'
];

/** The worktree, and everything Polaris writes into it. */
const PREPARE_WORKTREE = [
    'echo "polaris: fetching $GITHUB_REPOSITORY"',
    // The credential goes to git as a config value read from the environment,
    // never as part of the URL - which would put it in the reflog and in every
    // error message git prints.
    //
    // The ref the work starts from is a clone argument rather than a checkout
    // afterwards, because a shallow clone only carries the history of what it
    // was asked for. Empty is the repository's own default branch, which is what
    // almost every session wants.
    'if [ -n "$POLARIS_BASE_REF" ]; then',
    '  git clone --depth 50 --branch "$POLARIS_BASE_REF" -c http.extraHeader="$GIT_AUTH_HEADER" "https://github.com/$GITHUB_REPOSITORY.git" "$POLARIS_WORKDIR"',
    "else",
    '  git clone --depth 50 -c http.extraHeader="$GIT_AUTH_HEADER" "https://github.com/$GITHUB_REPOSITORY.git" "$POLARIS_WORKDIR"',
    "fi",
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
    //
    // Base64, and not for tidiness. The host daemon refuses any environment value
    // holding a control character - a deliberate rule, because these values are
    // rendered into a compose file and a newline in one of them writes YAML. All
    // three of these are files, every file has newlines, and so every session on
    // this box was refused before it started with a message about a variable name
    // nobody had ever seen. Base64 has no character that rule objects to, so the
    // rule keeps doing its job and the files still arrive.
    'mkdir -p "$POLARIS_WORKDIR/.claude"',
    'printf %s "$POLARIS_HOOK_SCRIPT" | base64 -d > "$POLARIS_WORKDIR/.claude/polaris-hook.sh"',
    'chmod +x "$POLARIS_WORKDIR/.claude/polaris-hook.sh"',
    'printf %s "$POLARIS_HOOK_SETTINGS" | base64 -d > "$POLARIS_WORKDIR/.claude/settings.local.json"',
    // The Polaris tools, registered in the worktree so the agent has them on its
    // first turn without anybody configuring anything.
    'printf %s "$POLARIS_MCP_CONFIG" | base64 -d > "$POLARIS_WORKDIR/.mcp.json"',
    'printf "%s\n%s\n" ".claude/" ".mcp.json" >> "$POLARIS_WORKDIR/.git/info/exclude"'
];

/**
 * Enigma, when the resolved settings asked for it, followed by the settings that
 * resolution actually landed on - the gate, and whatever the operator put in the
 * escape hatch. Both are best effort: a session without them works to weaker
 * standards, and failing the whole thing over a network blip would be worse.
 */
const INSTALL_ENIGMA = [
    // Globally, not through npx. npx downloads the package, runs its installer
    // and throws the download away - so the policies landed and `enigma` was not
    // on the PATH afterwards, which is what the agent went looking for and could
    // not find. Every `enigma config` line after it failed for the same reason,
    // silently, so an account's gate mode and its own settings reached nothing.
    'if [ -n "$POLARIS_ENIGMA_SETUP" ]; then',
    '  echo "polaris: installing Enigma"',
    // Not fatal. A session without Enigma works to weaker standards; one that
    // died because a registry was slow works to none.
    '  printf %s "$POLARIS_ENIGMA_SETUP" | base64 -d | sh || echo "polaris: Enigma did not install"',
    "fi"
];

/** The agent itself, where Polaris owns the machine. Best effort - the check that
 *  follows is what decides. */
const INSTALL_AGENT = [
    'if [ -n "$POLARIS_AGENT_INSTALL" ]; then',
    '  echo "polaris: installing $POLARIS_AGENT_BINARY"',
    '  sh -c "$POLARIS_AGENT_INSTALL" || echo "polaris: the install did not finish"',
    "fi"
];

const REQUIRE_AGENT = [
    'command -v "$POLARIS_AGENT_BINARY" >/dev/null 2>&1 || { echo "polaris: $POLARIS_AGENT_BINARY is not installed and could not be installed here"; exec sh; }'
];

/** The clone is done, so the credential that did it goes before the agent starts
 *  and can read its own environment. The token the agent's own git and GitHub
 *  tools need stays. */
/**
 * The file the setup touches immediately before the agent replaces it.
 *
 * "Is the agent up" used to be answered by asking whether the tmux session
 * existed, and that stopped being an answer the moment the setup moved inside
 * tmux: the session now exists from the first second, so the first prompt was
 * delivered into the middle of an npm install and the agent never saw it.
 *
 * A file rather than the pane's current command, which is what a vendor's
 * launcher happens to be called - `node` for one of these, a shell for another -
 * and would need a list nobody can keep right.
 */
export const AGENT_READY_FLAG = "/tmp/polaris-agent-started";

/** Whether the agent is actually up, for the caller holding a prompt. */
export function agentReadyCommand(): string {
    return `test -f ${AGENT_READY_FLAG}`;
}

const START_AGENT = [
    "unset GIT_AUTH_HEADER",
    "unset POLARIS_HOOK_SCRIPT POLARIS_HOOK_SETTINGS POLARIS_MCP_CONFIG POLARIS_ENIGMA_SETUP POLARIS_ENIGMA_CONFIGURE",
    // Not as root, and this is what "no server running" actually was.
    //
    // These tools refuse their own skip-permissions flag when they are running
    // as root - deliberately, and they are right to. So the agent started,
    // refused, and exited in the same second; the window went with it and tmux
    // took the session, which is why the terminal reported no server rather
    // than reporting what had happened.
    //
    // The container is root because installing packages needs it, so the
    // installing happens as root and the agent does not. It keeps sudo: the
    // point is not to take privileges away, it is to not BE root while holding
    // them.
    'if [ "$(id -u)" = "0" ] && id "$POLARIS_RUNAS" >/dev/null 2>&1; then',
    "  command -v sudo >/dev/null 2>&1 || apt-get install -y -qq sudo >/dev/null 2>&1 || true",
    '  printf "%s ALL=(ALL) NOPASSWD:ALL\\n" "$POLARIS_RUNAS" > /etc/sudoers.d/polaris-agent 2>/dev/null || true',
    "  chmod 0440 /etc/sudoers.d/polaris-agent 2>/dev/null || true",
    '  chown -R "$POLARIS_RUNAS" "$POLARIS_WORKDIR" 2>/dev/null || true',
    "fi",
    // Enigma's own settings, into the home of whoever will run the agent. The
    // package went in globally as root above; this half writes the skills, the
    // memory file, the commands and the trust and bypass settings, and it has to
    // land in the home the agent actually reads.
    'if [ -n "$POLARIS_ENIGMA_CONFIGURE" ]; then',
    '  printf %s "$POLARIS_ENIGMA_CONFIGURE" | base64 -d > /tmp/polaris-enigma.sh',
    "  chmod 0755 /tmp/polaris-enigma.sh",
    '  if [ "$(id -u)" = "0" ] && id "$POLARIS_RUNAS" >/dev/null 2>&1; then',
    '    su "$POLARIS_RUNAS" -c "sh /tmp/polaris-enigma.sh" || true',
    "  else",
    "    sh /tmp/polaris-enigma.sh || true",
    "  fi",
    "  rm -f /tmp/polaris-enigma.sh",
    "fi",
    'echo "polaris: starting $POLARIS_AGENT_COMMAND"',
    // Written last, so anything holding a prompt knows the terminal it is about
    // to type into belongs to the agent rather than to the installer.
    `: > ${AGENT_READY_FLAG}`,
    `chmod 0666 ${AGENT_READY_FLAG} 2>/dev/null || true`,
    'cd "$POLARIS_WORKDIR"',
    // Run rather than exec, and a shell afterwards. `exec` replaced this shell,
    // so an agent that exited for any reason took the window and the session
    // with it - and every word explaining why went too.
    'if [ "$(id -u)" = "0" ] && id "$POLARIS_RUNAS" >/dev/null 2>&1; then',
    '  su "$POLARIS_RUNAS" -c "cd \\"$POLARIS_WORKDIR\\" && $POLARIS_AGENT_COMMAND" || true',
    "else",
    "  $POLARIS_AGENT_COMMAND || true",
    "fi",
    'echo "polaris: the agent exited. This terminal is still yours."',
    "exec sh"
];

/**
 * Everything the session's terminal runs, from the first second.
 *
 * The whole of the setup lives inside the tmux window rather than in front of
 * it, and that is the fix for what people actually saw. It used to run BEFORE
 * tmux existed, silently, with every line sent to /dev/null - so for the two to
 * five minutes it spends cloning a repository and installing a package manager's
 * worth of tool, the session said it was waiting for you and anybody who took
 * the terminal got an empty box. If it then failed, nothing anywhere said so.
 *
 * Now the same window shows the clone, the installs and whatever they print, and
 * the agent takes it over when they are done. "Take the terminal" answers "what
 * is it doing" at every moment, including the moments when the answer is
 * "failing".
 */
export const SESSION_SETUP = [
    "set -e",
    ...PREPARE_WORKTREE,
    ...INSTALL_ENIGMA,
    ...INSTALL_AGENT,
    ...REQUIRE_AGENT,
    ...START_AGENT
].join("\n");

/** The setup as one argument tmux can be handed. Encoded for the reason every
 *  script here is: a command argument may not carry a control character, and a
 *  script is a line per statement. */
const SETUP_COMMAND = `sh -c 'echo ${Buffer.from(SESSION_SETUP, "utf8").toString("base64")} | base64 -d | sh'`;

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
    ...INSTALL_TMUX,
    ...REQUIRE_TMUX,
    'mkdir -p "$(dirname "$POLARIS_WORKDIR")"',
    // Everything else happens in there, where it can be watched.
    `tmux new-session -d -s "$POLARIS_TMUX" -x "$POLARIS_COLS" -y "$POLARIS_ROWS" ${SETUP_COMMAND}`,
    // Park. See above: the container outlives the agent inside it.
    "exec tail -f /dev/null"
].join("\n");

/**
 * The same boot, on a machine that is not Polaris's.
 *
 * Composed from the same fragments rather than filtered out of the script above.
 * A filter that drops lines by matching them drops every line that matches: one
 * more `if` anywhere in the boot and this variant loses a `fi` it needed, on the
 * one path that cannot be exercised from here.
 *
 * A server is somebody's machine. Polaris installs nothing on it - not tmux, not
 * the agent - does not park a foreground process on it, and says plainly what is
 * missing rather than reaching for a package manager it was never given
 * permission to use. The tmux session it starts outlives the SSH connection that
 * started it, which is the whole reason this shape works over SSH at all.
 */
export const SESSION_BOOT_FOR_HOST = [
    "set -eu",
    ...REQUIRE_TMUX,
    'mkdir -p "$(dirname "$POLARIS_WORKDIR")"',
    // Same shape as the container's, and for the same reason: a terminal
    // somebody opens has to show the setup rather than nothing until it
    // finishes. Polaris installs no agent here - a server is somebody's machine
    // - so the setup inside says what is missing instead.
    `tmux new-session -d -s "$POLARIS_TMUX" -x "$POLARIS_COLS" -y "$POLARIS_ROWS" ${SETUP_COMMAND}`
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

/**
 * The same, with lines that wrapped joined back together.
 *
 * `-J` is the difference between reading a screen and reading what was written
 * on it. A terminal breaks a long line at its own width, so an OAuth URL three
 * hundred characters long arrives as two or three rows with the break in the
 * middle of a query parameter - and anything trying to find that URL finds a
 * fragment ending in `scope=user%3`.
 *
 * Not the default, because for a session's own transcript the breaks are the
 * layout: a tool drawing boxes has every row exactly as wide as it meant it,
 * and joining them turns a table into a paragraph. This is for the one case
 * that wants the text rather than the picture.
 */
export function captureJoinedCommand(lines = 200, session = TMUX_SESSION): string {
    return `tmux capture-pane -p -J -t ${shellQuote(session)} -S -${Math.max(1, Math.floor(lines))}`;
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

/**
 * A whole script, as one argument the host daemon will accept.
 *
 * The daemon refuses any command argument carrying a control character, exactly
 * as it refuses an environment value carrying one, and for the same reason: both
 * are rendered into a compose file where a newline writes YAML. A boot script is
 * a program with a line per statement, so handing one over as `sh -c <script>`
 * is handing over an argument full of newlines - which is why every container
 * started that way was refused before it ran, with a message about control
 * characters in a command nobody wrote by hand.
 *
 * Base64 has no character that rule objects to, and none the shell reads either:
 * its alphabet is letters, digits, `+`, `/` and `=`. So the script travels
 * encoded inside a one-line command that decodes it and runs it, the daemon's
 * rule keeps doing its job, and the script stays readable in this file rather
 * than being flattened into semicolons.
 */
export function bootArgv(script: string): string[] {
    const encoded = Buffer.from(script, "utf8").toString("base64");
    return ["sh", "-c", `echo ${encoded} | base64 -d | sh`];
}

/**
 * The first address printed on a terminal, or null.
 *
 * Every one of these tools signs in the same way - it prints a URL and waits for
 * a code pasted back - and every one of them prints it into a terminal nobody
 * wanted to be looking at. Finding it is what turns "read this, select it
 * carefully, do not miss the last character" into a button.
 *
 * Deliberately not per-vendor. The rule is "the first http(s) address on the
 * screen", which is true of every login flow here and stays true of one nobody
 * has added yet; a pattern per tool would be a list to maintain and would still
 * be wrong for the eleventh.
 *
 * The trailing punctuation is trimmed because a terminal draws a URL inside a
 * sentence, and a bracket or a full stop swept into the address is a link that
 * 404s in a way nobody looks twice at.
 */
export function firstUrlIn(screen: string): string | null {
    const match = /https?:\/\/[^\s"'<>`]+/.exec(screen);
    if (!match) return null;
    return match[0].replace(/[.,;:!?)\]}]+$/, "") || null;
}
