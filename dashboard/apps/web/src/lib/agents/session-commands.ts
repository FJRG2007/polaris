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
import {
    FIRST_RUN_WORKDIR,
    promptSubmitDelayMs,
    sanitizeAgentPrompt,
    type AgentFirstRunAnswer
} from "@polaris/core";

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
 *  see `AGENT_ACCOUNT`. It is given passwordless sudo, so nothing it could reach
 *  before is out of reach now. */
export const CONTAINER_USER = "node";

/**
 * The home a `local` session keeps between sessions.
 *
 * This is the difference between Polaris and a machine somebody already owns,
 * and it was the whole of what was wrong. A desktop tool that runs agents runs
 * them where the person already installed the tool and already signed in to it;
 * every session here got a container with an empty home, so every session
 * installed a hundred megabytes of npm and then sat on a login prompt. Being
 * told to sign in to Claude, every time, on a machine you cannot see, is not a
 * worse version of that experience - it is no experience at all.
 *
 * So the home is a directory on the box, mounted into the container, one per
 * account. What lands in it is what makes the second session instant:
 *
 *   - `~/.claude` and its equivalents, so a sign-in done once is done. The
 *     person signs in in the session's own terminal - the thing they would do
 *     anyway - and never again.
 *   - `~/.npm-global`, so the agent and Enigma install on the first session and
 *     are simply found on every one after.
 *   - Whatever Enigma writes for itself: its skills, its memory, its settings.
 *
 * Per account rather than shared, because a credential is the account's. Two
 * people's sessions never see each other's home, and two of one person's
 * sessions see the same one - which is exactly what two terminals on one laptop
 * would do.
 */
export const AGENT_HOME = "/home/node";

/**
 * Where that home lives on the box, under the host daemon's own volume root.
 *
 * The daemon resolves a bind source inside that root and refuses anything that
 * escapes it, so this is a name rather than a path: the id is stripped to the
 * characters a directory name may have, and an id that survives that as nothing
 * is a bug worth stopping on rather than a session quietly sharing a home called
 * `""`.
 */
export function agentHomeSource(ownerId: string): string {
    const safe = ownerId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    if (!safe) throw new Error("Polaris could not work out where to keep this session's home.");
    // Prefixed, so no account id can ever land on the shared name below. An id
    // that happened to be the word would put one person's session in the machine
    // everybody shares, which is the one mistake here that cannot be undone by
    // noticing it later.
    return `agent-homes/u-${safe}`;
}

/**
 * The home a SHARED workspace keeps, which is nobody's in particular.
 *
 * One machine several people work on, with one set of logins and one set of
 * files - which is the point of it, and also the whole of what has to be said
 * out loud before anybody opens one. It is off unless an administrator turns it
 * on, and the screen that offers it says plainly that what is signed in there is
 * signed in for everybody who can reach it.
 *
 * Never derived from an account, so it cannot accidentally become somebody's.
 */
export const SHARED_HOME_SOURCE = "agent-homes/shared";

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

/**
 * Who the agent will be, and the home it keeps.
 *
 * First, because everything after it depends on both. The account is decided
 * once and answered from a variable rather than re-derived at each use, which is
 * what the three copies of this test used to be; `as_agent` is the one way
 * anything runs as the agent, so the installs land in the home the agent reads
 * rather than in root's - which is what put ninety-three of Enigma's files in
 * `/root` while the agent looked for them in `/home/node`.
 *
 * `su -p` rather than `su`, and that is the load-bearing flag: plain `su` resets
 * HOME and PATH, so the persistent home and the npm prefix inside it would be
 * thrown away at the exact moment they matter.
 */
const AGENT_ACCOUNT: readonly string[] = [
    "POLARIS_AS_ROOT=no",
    'if [ "$(id -u)" = "0" ] && [ -n "$POLARIS_RUNAS" ] && id "$POLARIS_RUNAS" >/dev/null 2>&1; then',
    "  POLARIS_AS_ROOT=yes",
    "fi",
    "as_agent() {",
    '  if [ "$POLARIS_AS_ROOT" = "yes" ]; then',
    '    su -p "$POLARIS_RUNAS" -c "$1"',
    "  else",
    '    sh -c "$1"',
    "  fi",
    "}",
    // Empty on an enrolled server, where the home is the person's own and
    // Polaris moves nothing into it.
    'if [ -n "$POLARIS_HOME" ]; then',
    '  mkdir -p "$POLARIS_HOME/.npm-global"',
    '  HOME="$POLARIS_HOME"',
    '  NPM_CONFIG_PREFIX="$POLARIS_HOME/.npm-global"',
    '  PATH="$POLARIS_HOME/.npm-global/bin:$PATH"',
    "  export HOME NPM_CONFIG_PREFIX PATH",
    "fi",
    'if [ "$POLARIS_AS_ROOT" = "yes" ]; then',
    "  command -v sudo >/dev/null 2>&1 || apt-get install -y -qq sudo >/dev/null 2>&1 || true",
    '  printf "%s ALL=(ALL) NOPASSWD:ALL\\n" "$POLARIS_RUNAS" > /etc/sudoers.d/polaris-agent 2>/dev/null || true',
    "  chmod 0440 /etc/sudoers.d/polaris-agent 2>/dev/null || true",
    // Once, on the session that creates it. Docker makes the directory as root,
    // so somebody has to hand it over - but doing it every session would be a
    // recursive chown over an npm tree, which is minutes of the thing this whole
    // change exists to remove.
    '  if [ -n "$POLARIS_HOME" ] && [ ! -f "$POLARIS_HOME/.polaris-home" ]; then',
    '    echo "polaris: preparing this account\'s workspace, once"',
    '    chown -R "$POLARIS_RUNAS" "$POLARIS_HOME" 2>/dev/null || true',
    '    : > "$POLARIS_HOME/.polaris-home"',
    '    chown "$POLARIS_RUNAS" "$POLARIS_HOME/.polaris-home" 2>/dev/null || true',
    "  fi",
    "fi"
];

/**
 * The same preamble, for anything else Polaris starts in one of these
 * containers.
 *
 * Shared rather than copied because a sign-in and a session have to agree about
 * WHERE the login lands, exactly: a login written into root's home by one and
 * read from the agent's home by the other is a dialog that says it worked and a
 * session that asks again.
 */
export const AGENT_ACCOUNT_SETUP = AGENT_ACCOUNT.join("\n");

/**
 * The worktree, and everything Polaris writes into it.
 *
 * Or no worktree at all. A session with no repository is somebody opening an
 * agent on a machine of their own with nothing checked out - which is what a
 * person does on their own laptop, and was the one shape this could not express.
 * That directory lives inside the home that is kept, so what they make in it is
 * still there next time; a checkout does not, because a session about a
 * repository starts from the repository rather than from what the last one left
 * behind.
 */
const PREPARE_WORKTREE = [
    // Nothing in this session may ever stop to ask a person for a password.
    //
    // Not a tidying flag: the setup runs on a real terminal now, and a git that
    // is handed one asks for a username the moment a credential is refused -
    // then waits, forever, on a machine whose owner is looking at a screen that
    // says "Starting". The failure has to be a failure, immediately, with the
    // reason on the screen. It stays exported for the agent's own git too, which
    // needs the same thing for the same reason.
    "GIT_TERMINAL_PROMPT=0",
    "export GIT_TERMINAL_PROMPT",
    // Whether this directory is one Polaris just made. A checkout always is; a
    // workspace is only on the session that opens it for the first time, and
    // every one after that finds what the last one left. See the chown below.
    "POLARIS_WORKDIR_NEW=no",
    'if [ -z "$GITHUB_REPOSITORY" ]; then',
    '  echo "polaris: opening your workspace"',
    '  if [ ! -d "$POLARIS_WORKDIR" ]; then',
    '    mkdir -p "$POLARIS_WORKDIR"',
    "    POLARIS_WORKDIR_NEW=yes",
    "  fi",
    '  cd "$POLARIS_WORKDIR"',
    "else",
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
    "POLARIS_WORKDIR_NEW=yes",
    "fi",
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
    // Only where there is a checkout to exclude them from. A workspace has no
    // git directory, and appending into one that is not there fails the whole
    // setup under `set -e` - a session that dies on its way up for want of a
    // file nobody asked for.
    'if [ -d "$POLARIS_WORKDIR/.git" ]; then',
    '  printf "%s\n%s\n" ".claude/" ".mcp.json" >> "$POLARIS_WORKDIR/.git/info/exclude"',
    "fi",
    // Made as root because the image starts as root; owned by the agent, because
    // the agent is who edits it.
    //
    // Recursively only the once, for the same reason the home's is: a checkout
    // is a fresh tree and cheap to walk, but a workspace is kept and fills with
    // node_modules and caches, so a walk of it on every boot is minutes of
    // exactly the wait this whole thing exists to remove. On a workspace that is
    // already there, only the files Polaris just wrote into it change hands.
    'if [ "$POLARIS_AS_ROOT" = "yes" ]; then',
    '  if [ "$POLARIS_WORKDIR_NEW" = "yes" ]; then',
    '    chown -R "$POLARIS_RUNAS" "$POLARIS_WORKDIR" 2>/dev/null || true',
    "  else",
    '    chown "$POLARIS_RUNAS" "$POLARIS_WORKDIR/.claude" "$POLARIS_WORKDIR/.claude/polaris-hook.sh" "$POLARIS_WORKDIR/.claude/settings.local.json" "$POLARIS_WORKDIR/.mcp.json" 2>/dev/null || true',
    "  fi",
    "fi"
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
    //
    // Skipped outright when it is already here, which after the first session it
    // is: the npm prefix lives in the home that is kept.
    'if [ -n "$POLARIS_ENIGMA_SETUP" ] && ! command -v enigma >/dev/null 2>&1; then',
    '  echo "polaris: installing Enigma"',
    // Not fatal. A session without Enigma works to weaker standards; one that
    // died because a registry was slow works to none.
    '  printf %s "$POLARIS_ENIGMA_SETUP" | base64 -d > /tmp/polaris-enigma-setup.sh',
    '  as_agent "sh /tmp/polaris-enigma-setup.sh" || echo "polaris: Enigma did not install"',
    "  rm -f /tmp/polaris-enigma-setup.sh",
    "fi"
];

/** The agent itself, where Polaris owns the machine. Best effort - the check that
 *  follows is what decides. */
const INSTALL_AGENT = [
    'if [ -n "$POLARIS_AGENT_INSTALL" ] && ! command -v "$POLARIS_AGENT_BINARY" >/dev/null 2>&1; then',
    '  echo "polaris: installing $POLARIS_AGENT_BINARY. This happens once - the next session starts with it already here."',
    '  as_agent "$POLARIS_AGENT_INSTALL" || echo "polaris: the install did not finish"',
    'elif [ -n "$POLARIS_AGENT_INSTALL" ]; then',
    '  echo "polaris: $POLARIS_AGENT_BINARY is already installed here"',
    "fi"
];

const REQUIRE_AGENT = [
    'command -v "$POLARIS_AGENT_BINARY" >/dev/null 2>&1 || { echo "polaris: $POLARIS_AGENT_BINARY is not installed and could not be installed here"; exec sh; }'
];

/** The clone is done, so the credential that did it goes before the agent starts
 *  and can read its own environment. The token the agent's own git and GitHub
 *  tools need stays. */
/**
 * The file the setup touches immediately before it launches the agent.
 *
 * "Is the agent up" used to be answered by asking whether the tmux session
 * existed, and that stopped being an answer the moment the setup moved inside
 * tmux: the session now exists from the first second, so the first prompt was
 * delivered into the middle of an npm install and the agent never saw it.
 *
 * A file rather than the pane's current command, which is what a vendor's
 * launcher happens to be called - `node` for one of these, a shell for another -
 * and would need a list nobody can keep right.
 *
 * On its own it is a floor and not an answer, because the setup writes it and
 * then still has to get through Enigma's launcher and the tool's own startup -
 * seconds in which the flag says yes and there is nothing there to type into.
 * See `agentReadyCommand`.
 */
export const AGENT_READY_FLAG = "/tmp/polaris-agent-started";

/**
 * A settled agent that never took the terminal, and the wait after which Polaris
 * types at it anyway.
 *
 * The raw-mode test below is the right question for the tools this is built for
 * and the wrong one for an operator's own command, which may be a script that
 * reads a line at a time and is perfectly ready. So the flag being a minute old
 * is accepted as an answer too: a full-screen tool has taken the terminal long
 * before that, and anything that has not is something the test cannot recognise
 * rather than something still starting.
 */
const AGENT_SETTLED_MINUTES = 1;

/**
 * Whether the agent is actually up, for the caller holding a prompt.
 *
 * The flag, and then the terminal itself. A full-screen tool takes the pane out
 * of the line discipline's hands the moment it starts - no canonical mode, no
 * echo - and that is exactly the property a paste depends on: something is
 * reading this terminal as keys rather than a shell buffering a line nobody will
 * collect. Asking `stty` about the pane's own tty answers it for every one of
 * these tools without naming any of them, which is what a list of process names
 * could never do.
 *
 * It is what the first prompt of every session was missing. The flag is written
 * one line before the launch, so it was true several seconds before there was an
 * agent, and the prompt went to the shell - where the terminal echoed it as text
 * and it was never delivered to anything.
 *
 * One thing this rests on, so it is written down rather than rediscovered: the
 * shells in these scripts are `sh`, which reads a line the terminal's own way
 * and leaves canonical mode alone. A shell with readline - bash, zsh - takes the
 * terminal exactly as a full-screen tool does, and swapping one in anywhere
 * around the launch would make this answer yes for a shell.
 */
export function agentReadyCommand(session = TMUX_SESSION): string {
    const tty = `$(tmux display-message -p -t ${shellQuote(session)} '#{pane_tty}' 2>/dev/null)`;
    const raw = `stty -F "${tty}" -a 2>/dev/null | grep -q -- -icanon`;
    const settled = `[ -n "$(find ${AGENT_READY_FLAG} -mmin +${AGENT_SETTLED_MINUTES} 2>/dev/null)" ]`;
    return `test -f ${AGENT_READY_FLAG} && { ${raw} || ${settled}; }`;
}

/**
 * The tool's own first-run wizard, answered before it can be asked.
 *
 * A fresh home is a machine the tool has never run on, so it does what it does
 * for anybody: it opens on "choose the text style that looks best with your
 * terminal", and then on "select login method" - and both of them read single
 * keystrokes, so the prompt Polaris pastes next is eaten rather than answered.
 * From outside, a session sitting on that menu is indistinguishable from an
 * agent thinking hard. It is `autonomyArgs` all over again, one screen earlier
 * and holding a login this instance had already been given.
 *
 * Only where Polaris owns the home. On somebody's own server the home is theirs,
 * the tool ran there long before Polaris did, and writing our answers into their
 * configuration is exactly what this file refuses to do everywhere else.
 *
 * Absent keys only, and absent at every level of nesting: a person who opens the
 * session and picks a light theme keeps it, and a folder that already has an
 * answer keeps that answer too - the question is answered once, and the answer
 * is never overruled.
 *
 * One of these questions is not about the tool but about the checkout: Claude
 * Code's workspace-trust dialog, which defaults to "No, exit" on a folder it has
 * never seen and is recorded per project path rather than as a flag at the top
 * of the file. `FIRST_RUN_WORKDIR` stands in for that path in the answer, and is
 * replaced here with the session's own worktree - or the answer is left out
 * entirely where there is no worktree yet, such as a sign-in container.
 */
/**
 * The program that writes the answers, on its own.
 *
 * Separate from the script around it so a test can RUN it rather than read it.
 * Everything here is decided by what it does to a real directory - a folder that
 * was already answered `false`, a theme somebody chose, a path that cannot be
 * written - and a test that greps the source for a line proves none of that.
 */
export function firstRunProgram(): string {
    return [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        "const home = process.env.HOME;",
        "if (!home) process.exit(0);",
        // The directory this session works in, for the answers that are about
        // the FOLDER rather than about the tool. Empty where there is no
        // worktree - a sign-in container - and an answer needing it is skipped
        // there rather than written under a key still spelling the placeholder.
        'const workdir = process.env.POLARIS_WORKDIR || "";',
        // Deep, because one of these answers is two levels down, and
        // absent-only at every level: a folder somebody has already answered
        // for keeps its answer, exactly as a theme they have chosen does.
        //
        // A branch that is not there yet is filled aside and attached only if
        // something reached a leaf inside it, so an answer skipped for want of a
        // worktree leaves no empty `projects: {}` behind in the tool's own file.
        // `assert` is the difference between filling in what a file does not say
        // and writing what is Polaris's to say. A folder Polaris made, which an
        // agent already answered No to on a screen nobody could reach, is the
        // second kind - see `CLAUDE_TRUST_ANSWER`.
        "function fill(target, source, assert) {",
        "    let wrote = false;",
        "    for (const [name, value] of Object.entries(source)) {",
        `        const key = name === ${JSON.stringify(FIRST_RUN_WORKDIR)} ? workdir : name;`,
        "        if (!key) continue;",
        '        if (value && typeof value === "object") {',
        "            const branch = target[key];",
        "            if (branch === undefined) {",
        "                const fresh = {};",
        "                if (fill(fresh, value, assert)) { target[key] = fresh; wrote = true; }",
        '            } else if (branch && typeof branch === "object" && !Array.isArray(branch)) {',
        "                if (fill(branch, value, assert)) wrote = true;",
        "            }",
        // Written when the file is silent, or when it says something else and this
        // is an answer Polaris gives. Never when it already agrees, so a session
        // with nothing to do writes nothing and prints nothing.
        "        } else if (target[key] === undefined || (assert && target[key] !== value)) {",
        "            target[key] = value; wrote = true;",
        "        }",
        "    }",
        "    return wrote;",
        "}",
        'for (const answer of JSON.parse(fs.readFileSync(process.argv[1], "utf8"))) {',
        "    const file = path.join(home, answer.file);",
        "    let current = {};",
        // A file that is not there, or is half-written, is answered the same way
        // as an empty one. The alternative is a session that will not start
        // because a cache file the tool owns had a byte out of place.
        '    try { current = JSON.parse(fs.readFileSync(file, "utf8")); } catch { current = {}; }',
        '    if (!current || typeof current !== "object" || Array.isArray(current)) current = {};',
        "    let changed = fill(current, answer.json, false);",
        "    if (answer.assert && fill(current, answer.assert, true)) changed = true;",
        "    if (!changed) continue;",
        // Said out loud, on the screen somebody is watching - and said AFTER the
        // write rather than before it. Where a tool keeps its configuration is a
        // thing that MOVES: Claude Code's file follows CLAUDE_CONFIG_DIR, so a
        // launcher that sets it relocates the file, and the failure that causes
        // is invisible by nature - the answer is written, nothing reads it, the
        // question is asked anyway, and the terminal says nothing. A line naming
        // the file is what turns that into something a person sees the first
        // time, and it is worth nothing if it can appear for a file never
        // written.
        //
        // Each answer stands on its own, so a path that cannot be written is
        // named on the screen instead of taking every answer after it down with
        // it. One unwritable file is one tool asking its question; an abort is
        // every question left unanswered.
        "    try {",
        "        fs.mkdirSync(path.dirname(file), { recursive: true });",
        '        fs.writeFileSync(file, JSON.stringify(current, null, 2) + "\\n");',
        '        console.log("polaris: answered its first run in " + file);',
        "    } catch (error) {",
        '        console.log("polaris: could not write " + file + " (" + error.message + ")");',
        "    }",
        "}"
    ].join("\n");
}

export function firstRunScript(answers: readonly AgentFirstRunAnswer[]): string {
    if (answers.length === 0) return "";
    // Node rather than a shell: these are JSON documents the tool wrote and will
    // rewrite, and every other way of editing one from a shell corrupts it the
    // first time a value contains something interesting. The image the container
    // runs is a Node image, and this only ever runs there.
    const program = firstRunProgram();
    return [
        `printf %s ${shellQuote(JSON.stringify(answers))} > ${FIRST_RUN_FILE}`,
        `node -e ${shellQuote(program)} ${FIRST_RUN_FILE}`,
        `rm -f ${FIRST_RUN_FILE}`
    ].join("\n");
}

/** Where the answers land on the way in. Beside the other scripts the setup
 *  writes and removes, and holding nothing secret - the tool's own defaults. */
const FIRST_RUN_FILE = "/tmp/polaris-first-run.json";

const START_AGENT = [
    // Enigma's own settings, into the home the agent reads - the skills, the
    // memory file, the commands, the trust and bypass settings.
    //
    // Before the unset below, which is where this used to be and is why none of
    // it ever ran: the variable was cleared two lines above the `if` that tested
    // it, so every session installed Enigma and then configured nothing.
    'if [ -n "$POLARIS_ENIGMA_CONFIGURE" ]; then',
    '  printf %s "$POLARIS_ENIGMA_CONFIGURE" | base64 -d > /tmp/polaris-enigma.sh',
    "  chmod 0755 /tmp/polaris-enigma.sh",
    '  as_agent "sh /tmp/polaris-enigma.sh" || true',
    "  rm -f /tmp/polaris-enigma.sh",
    "fi",
    // After Enigma, which writes into the same files, and before the launch,
    // which is the last moment anything can answer a question the tool is about
    // to ask on a screen nobody can reach. Only where Polaris owns the home.
    'if [ -n "$POLARIS_FIRST_RUN" ] && [ -n "$POLARIS_HOME" ]; then',
    '  printf %s "$POLARIS_FIRST_RUN" | base64 -d > /tmp/polaris-first-run.sh',
    "  chmod 0755 /tmp/polaris-first-run.sh",
    // Best effort, like everything else that prepares the home: a session that
    // has to answer its own theme menu is worse than one that does not start.
    '  as_agent "sh /tmp/polaris-first-run.sh" || true',
    "  rm -f /tmp/polaris-first-run.sh",
    "fi",
    "unset GIT_AUTH_HEADER",
    "unset POLARIS_HOOK_SCRIPT POLARIS_HOOK_SETTINGS POLARIS_MCP_CONFIG POLARIS_ENIGMA_SETUP POLARIS_ENIGMA_CONFIGURE POLARIS_FIRST_RUN",
    // Said once, in the terminal the person is looking at, because on a machine
    // they cannot see "please sign in" with no way to and no reason given is the
    // whole of what was wrong with this. Only when Polaris is carrying no
    // credential of its own - if it is, the tool comes up signed in.
    'if [ -z "$POLARIS_SIGNED_IN" ]; then',
    '  echo "polaris: if this asks you to sign in, do it right here. This machine keeps its home, so it only asks once."',
    "fi",
    // Through Enigma where Polaris asked for it AND Enigma is actually here.
    // Both halves matter: `enigma claude` is what applies the settings Polaris
    // stood aside for and picks which login to run under, and the install that
    // put it there is best effort - so a launcher that did not arrive falls back
    // to the tool itself rather than being a command not found in the same
    // second the session starts.
    'POLARIS_LAUNCH="$POLARIS_AGENT_COMMAND"',
    'if [ -n "$POLARIS_AGENT_LAUNCHER" ] && command -v "$POLARIS_AGENT_LAUNCHER" >/dev/null 2>&1; then',
    '  POLARIS_LAUNCH="$POLARIS_AGENT_LAUNCHER $POLARIS_AGENT_COMMAND"',
    // Said where somebody will read it, because nothing else advertises this: a
    // machine that keeps its home can hold several logins, and one command makes
    // the next one.
    "  echo \"polaris: this machine keeps its logins. 'enigma account add <name> --login' adds another, 'enigma account use <name>' picks it.\"",
    "fi",
    'echo "polaris: starting $POLARIS_LAUNCH"',
    // Written last, so anything holding a prompt knows the terminal it is about
    // to type into belongs to the agent rather than to the installer.
    `: > ${AGENT_READY_FLAG}`,
    `chmod 0666 ${AGENT_READY_FLAG} 2>/dev/null || true`,
    'cd "$POLARIS_WORKDIR"',
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
    //
    // Run rather than exec, and a shell afterwards. `exec` replaced this shell,
    // so an agent that exited for any reason took the window and the session
    // with it - and every word explaining why went too.
    'as_agent "cd \\"$POLARIS_WORKDIR\\" && $POLARIS_LAUNCH" || true',
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
    ...AGENT_ACCOUNT,
    ...PREPARE_WORKTREE,
    ...INSTALL_ENIGMA,
    ...INSTALL_AGENT,
    ...REQUIRE_AGENT,
    ...START_AGENT
].join("\n");

/**
 * The setup as one argument tmux can be handed.
 *
 * Encoded for the reason every script here is: a command argument may not carry
 * a control character, and a script is a line per statement.
 *
 * Decoded with `eval` rather than piped into `sh`, and that is the whole of why
 * a session used to sit on "Starting" forever with an empty terminal.
 * `... | base64 -d | sh` hands that shell a PIPE as its standard input, and
 * every process it starts inherits it - so the agent was launched onto a
 * terminal it could write to and could not read from, with the pipe already at
 * end of file. A tool whose entire interface is a full-screen terminal cannot
 * come up like that: it drew nothing, no session-start ever reached Polaris, and
 * the first prompt was echoed onto the screen as plain text by a line discipline
 * with nobody behind it. That echoed prompt is the symptom to recognise - it
 * means the terminal reached a shell instead of an agent.
 *
 * The sign-in container never had this, and the difference is the whole
 * diagnosis: it hands its command to `tmux new-session` as an argument, so tmux
 * runs it on the pane's own terminal. `eval` gets the setup the same thing - the
 * pipe is confined to the substitution that decodes it, and the shell that then
 * runs it keeps the terminal on all three descriptors.
 */
const SETUP_COMMAND = `sh -c 'eval "$(echo ${Buffer.from(SESSION_SETUP, "utf8").toString("base64")} | base64 -d)"'`;

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
