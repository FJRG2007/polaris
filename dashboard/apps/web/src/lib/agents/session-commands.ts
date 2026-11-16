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
import { INSTALL_GH, PREINSTALL_GH } from "./session-gh";
import {
    FIRST_RUN_WORKDIR,
    HOOK_BLOCK_END,
    HOOK_BLOCK_START,
    HOOK_FILE_WORKDIR,
    hasControlCharacter,
    isAgentEffortLevel,
    SAFE_MODEL_ID,
    isVendorSessionId,
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

/**
 * Where a local session's own directory lives on the box: its checkout and
 * Polaris's files for it, mounted at `SESSION_ROOT`.
 *
 * On the box rather than in the container's own layer, so the work survives the
 * container being recreated - by a restart of the machine, or by an update of
 * the daemon. Removed when the session ends with its work saved. See
 * `releaseCheckout` in session-work.ts.
 */
export function sessionCheckoutSource(sessionId: string): string {
    const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    if (!safe) throw new Error("Polaris could not work out where to keep this session's checkout.");
    return `agent-sessions/s-${safe}`;
}

/** Where that directory is mounted inside the container. */
export const SESSION_ROOT = "/session";

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
    // Where the vendors' own install scripts put their binary (Cursor, Kiro,
    // fx and most of the curl installers in the catalogue), so a tool installed
    // that way is found by the check that follows rather than reported missing.
    'PATH="$HOME/.local/bin:$PATH"',
    "export PATH",
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
    // A server's directories are stored as `$HOME/...` and arrive quoted, so the
    // shell would otherwise make a directory literally named `$HOME`, while the
    // hook command the agent runs expands it - two different places.
    'case "$POLARIS_WORKDIR" in \x27$HOME\x27/*) POLARIS_WORKDIR="$HOME/$(printf %s "$POLARIS_WORKDIR" | cut -c7-)" ;; esac',
    'case "$POLARIS_STATE_DIR" in \x27$HOME\x27/*) POLARIS_STATE_DIR="$HOME/$(printf %s "$POLARIS_STATE_DIR" | cut -c7-)" ;; esac',
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
    "POLARIS_REOPENED=no",
    // Polaris's own files for this session, outside the checkout. Private to the
    // agent's account: two of them carry the session's token.
    'mkdir -p "$POLARIS_STATE_DIR"',
    'chmod 0700 "$POLARIS_STATE_DIR"',
    'if [ -z "$GITHUB_REPOSITORY" ]; then',
    '  echo "polaris: opening your workspace"',
    '  if [ ! -d "$POLARIS_WORKDIR" ]; then',
    '    mkdir -p "$POLARIS_WORKDIR"',
    "    POLARIS_WORKDIR_NEW=yes",
    "  fi",
    '  cd "$POLARIS_WORKDIR"',
    // A checkout that is already there is this session's own, kept across a
    // restart of its machine: the branch, the commits and whatever the agent had
    // not committed yet. Cloning over it would throw all of that away, so the
    // session reopens on it instead.
    'elif [ -d "$POLARIS_WORKDIR/.git" ]; then',
    '  echo "polaris: reopening $GITHUB_REPOSITORY"',
    "  POLARIS_REOPENED=yes",
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
    // `clone -c` writes the header into the new repository's own config, so the
    // clone token would otherwise sit in .git/config for the agent to read.
    "git config --unset-all http.extraHeader || true",
    'git checkout -b "$POLARIS_BRANCH"',
    "POLARIS_WORKDIR_NEW=yes",
    "fi",
    // From here on git asks Polaris for a token scoped to this repository each
    // time it needs one, rather than the agent holding one. See
    // `gitCredentialScript`. Written on a reopen too: the helper carries the
    // session's reporting token, and a reopened server session has a new one.
    'if [ -n "$GITHUB_REPOSITORY" ] && [ -n "$POLARIS_GIT_CREDENTIAL" ]; then',
    '  printf %s "$POLARIS_GIT_CREDENTIAL" | base64 -d > "$POLARIS_STATE_DIR/git-credential.sh"',
    '  chmod 0700 "$POLARIS_STATE_DIR/git-credential.sh"',
    "  git config --unset-all credential.helper || true",
    "  git config --unset-all credential.username || true",
    '  git config credential.https://github.com.helper "!sh \\"$POLARIS_STATE_DIR/git-credential.sh\\""',
    "  git config credential.https://github.com.username x-access-token",
    "fi",
    // The agent reports what it is doing through a script Polaris registers in
    // the agent's own configuration, and gets the Polaris tools through an MCP
    // registration. Written from the environment so neither the URL nor the
    // token is ever an argument.
    //
    // BESIDE the checkout, never inside it. These files carry the session's own
    // bearer token, and a file in the worktree is a file the agent can commit:
    // `.git/info/exclude` hides nothing a repository already tracks, and plenty
    // of repositories track `.mcp.json` - so writing ours over theirs both threw
    // away the repository's own servers and put the token one `git add -A` away
    // from a push. Outside the worktree there is nothing to exclude and nothing
    // of the repository's to overwrite. The agent is pointed at them with its
    // own flags instead (see START_AGENT), which also keeps them out of the
    // home: on somebody's own server that home is theirs, and hooks written
    // there would hijack every agent that person ever starts.
    //
    // Base64, and not for tidiness. The host daemon refuses any environment value
    // holding a control character - a deliberate rule, because these values are
    // rendered into a compose file and a newline in one of them writes YAML. All
    // three of these are files, every file has newlines, and so every session on
    // this box was refused before it started with a message about a variable name
    // nobody had ever seen. Base64 has no character that rule objects to, so the
    // rule keeps doing its job and the files still arrive.
    'printf %s "$POLARIS_HOOK_SCRIPT" | base64 -d > "$POLARIS_STATE_DIR/hook.sh"',
    'chmod 0700 "$POLARIS_STATE_DIR/hook.sh"',
    'printf %s "$POLARIS_HOOK_SETTINGS" | base64 -d > "$POLARIS_STATE_DIR/settings.json"',
    'printf %s "$POLARIS_MCP_CONFIG" | base64 -d > "$POLARIS_STATE_DIR/mcp.json"',
    'chmod 0600 "$POLARIS_STATE_DIR/settings.json" "$POLARIS_STATE_DIR/mcp.json"',
    // The script that carries the repository's memory between boxes (see
    // `memorySyncScript`). It holds the session's token, so it is private like
    // the hook script. Absent where no memory is carried.
    'if [ -n "$POLARIS_MEMORY_SYNC" ]; then',
    '  printf %s "$POLARIS_MEMORY_SYNC" | base64 -d > "$POLARIS_STATE_DIR/memory-sync.sh"',
    '  chmod 0700 "$POLARIS_STATE_DIR/memory-sync.sh"',
    "fi",
    // The script that fetches the person's Polar skills (`skillsSyncScript`).
    // It holds the session's token too. Absent where the home is not theirs.
    'if [ -n "$POLARIS_SKILLS_SYNC" ]; then',
    '  printf %s "$POLARIS_SKILLS_SYNC" | base64 -d > "$POLARIS_STATE_DIR/skills-sync.sh"',
    '  chmod 0700 "$POLARIS_STATE_DIR/skills-sync.sh"',
    "fi",
    // A hook configuration of the session's own, for a tool pointed at one
    // through a variable (`sessionHookConfig`). Private like the hook script:
    // Codewhale's names the session's address, token and all. Only ever inside
    // the state directory, whatever the path says.
    'if [ -n "$POLARIS_AGENT_HOOK_FILE" ]; then',
    '  case "$POLARIS_AGENT_HOOK_PATH" in',
    '    "$POLARIS_STATE_DIR"/*/*|*..*) ;;',
    '    "$POLARIS_STATE_DIR"/?*) printf %s "$POLARIS_AGENT_HOOK_FILE" | base64 -d > "$POLARIS_AGENT_HOOK_PATH" && chmod 0600 "$POLARIS_AGENT_HOOK_PATH" || true ;;',
    "  esac",
    "fi",
    // Made as root because the image starts as root; owned by the agent, because
    // the agent is who edits it.
    //
    // Recursively only the once, for the same reason the home's is: a checkout
    // is a fresh tree and cheap to walk, but a workspace is kept and fills with
    // node_modules and caches, so a walk of it on every boot is minutes of
    // exactly the wait this whole thing exists to remove.
    'if [ "$POLARIS_AS_ROOT" = "yes" ]; then',
    '  if [ "$POLARIS_WORKDIR_NEW" = "yes" ]; then',
    '    chown -R "$POLARIS_RUNAS" "$POLARIS_WORKDIR" 2>/dev/null || true',
    "  fi",
    '  chown -R "$POLARIS_RUNAS" "$POLARIS_STATE_DIR" 2>/dev/null || true',
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
    // The script itself returns at once when the pinned version is already here,
    // which after the first session it is: the install lives in the home that is
    // kept. Testing only for `enigma` here is what kept every home on the first
    // version it ever installed.
    'if [ -n "$POLARIS_ENIGMA_SETUP" ]; then',
    // Not fatal. A session without Enigma works to weaker standards; one that
    // died because a registry was slow works to none.
    '  printf %s "$POLARIS_ENIGMA_SETUP" | base64 -d > $(printenv TMPDIR || echo /tmp)/polaris-enigma-setup.sh',
    '  as_agent "sh $(printenv TMPDIR || echo /tmp)/polaris-enigma-setup.sh" || echo "polaris: Enigma did not install"',
    "  rm -f $(printenv TMPDIR || echo /tmp)/polaris-enigma-setup.sh",
    "fi"
];

/**
 * A spare's installs, while they are still running: the file exists from the
 * moment they start until they end. See `SPARE_PREINSTALL`.
 *
 * In the container's own `/tmp` rather than the kept home, because it is about
 * this container's background job and nothing else: a second container on the
 * same home has no job to wait for. A restart keeps `/tmp`, so the spare boot
 * removes it first, and the wait below is bounded either way.
 */
export const PREINSTALL_PENDING = "/tmp/polaris-preinstall.pending";

/** What those installs print, shown in the session's window while it waits. */
export const PREINSTALL_LOG = "/tmp/polaris-preinstall.log";

/** How long the session waits on a spare's installs before doing them itself,
 *  in half seconds: ten minutes, well past the slowest install measured. */
const PREINSTALL_WAIT_TICKS = 1200;

/**
 * What a spare installs before it has a session, so the person is not the one
 * waiting for it: sudo, Enigma and the GitHub CLI, none of which depend on the
 * session. Measured on a production boot: 41.6 s of Enigma after a version bump,
 * 3.3 s of `gh` and 2 s of `apt-get install sudo`, all after the message was
 * sent.
 *
 * The account preamble (and with it sudo and the once-only hand-over of the
 * home) runs in front, because the session's own preamble would otherwise race
 * it for the package manager's lock. Enigma and `gh` run behind, so a claim that
 * arrives meanwhile starts fetching the repository at once; the session's setup
 * waits for `PREINSTALL_PENDING` to go before its own Enigma step, which then
 * finds the pinned version already installed and returns.
 *
 * Only when the spare was handed the account (`POLARIS_RUNAS`); a spare started
 * without it waits exactly as it used to. Best effort throughout: anything that
 * did not install here is installed after the claim, as it always was.
 */
export const SPARE_PREINSTALL: readonly string[] = [
    `rm -f ${PREINSTALL_PENDING}`,
    'if [ -n "$(printenv POLARIS_RUNAS)" ]; then',
    "  (",
    "    set +eu",
    ...AGENT_ACCOUNT.map((line) => `    ${line}`),
    "  ) || true",
    `  : > ${PREINSTALL_PENDING}`,
    "  (",
    "    set +eu",
    ...AGENT_ACCOUNT.map((line) => `    ${line}`),
    ...INSTALL_ENIGMA.map((line) => `    ${line}`),
    ...PREINSTALL_GH.map((line) => `    ${line}`),
    `    rm -f ${PREINSTALL_PENDING}`,
    `  ) > ${PREINSTALL_LOG} 2>&1 &`,
    "fi"
];

/**
 * The session's side of that: never a second install into the same folder
 * while the spare's is still writing it. Shows what the spare's installs print
 * while it waits, so the window (and the progress read off it) says "installing
 * Enigma" rather than nothing. Returns at once on any container that is not a
 * claimed spare, where the file never exists.
 */
export const AWAIT_PREINSTALL: readonly string[] = [
    `if [ -f ${PREINSTALL_PENDING} ]; then`,
    `  tail -n +1 -f ${PREINSTALL_LOG} 2>/dev/null &`,
    "  polaris_tail=$!",
    "  polaris_waited=0",
    `  while [ -f ${PREINSTALL_PENDING} ] && [ "$polaris_waited" -lt ${PREINSTALL_WAIT_TICKS} ]; do`,
    "    sleep 0.5",
    "    polaris_waited=$((polaris_waited + 1))",
    "  done",
    '  kill "$polaris_tail" 2>/dev/null || true',
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
export const AGENT_READY_FLAG = "$(printenv TMPDIR || echo /tmp)/polaris-agent-started";

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
 * Whether the agent has exited and its window is back at the shell.
 *
 * The inverse of the question `agentReadyCommand` asks: a full-screen tool
 * takes the pane out of canonical mode, and the `sh` the window falls back to
 * leaves it in. So a pane in canonical mode is a shell waiting for a line, which
 * is the only moment typing a launch into it does what the button says.
 */
export function agentExitedCommand(session = TMUX_SESSION, stateDir?: string): string {
    const tty = `$(tmux display-message -p -t ${shellQuote(session)} '#{pane_tty}' 2>/dev/null)`;
    // A runner's window is a shell between turns, and it is not an agent that
    // exited: there is nothing to type a launch into.
    if (stateDir) return `! ${runnerIn(stateDir)} && ${agentExitedCommand(session)}`;
    // The flag first: during the boot the pane is the setup script, which is in
    // canonical mode too and is not an agent that has exited.
    return `test -f ${AGENT_READY_FLAG} && stty -F "${tty}" -a 2>/dev/null | tr ' ' '\\n' | grep -qx icanon`;
}

/**
 * The line typed into that shell to bring the agent back on a conversation.
 *
 * The id is checked here and again by the launch script, because it came from a
 * hook payload - text the agent's machine sent - and it is about to be typed
 * into a shell. Literal keys rather than a paste: a shell does not ask for
 * bracketed paste, and the line has no newline to protect.
 */
export function resumeCommand(vendorSessionId: string, session = TMUX_SESSION): string {
    if (!isVendorSessionId(vendorSessionId))
        throw new Error("That is not a conversation Polaris can reopen.");
    const line = `sh "$POLARIS_STATE_DIR/launch.sh" ${vendorSessionId}`;
    return `tmux send-keys -t ${shellQuote(session)} -l ${shellQuote(line)}`;
}

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
        'const { execFileSync } = require("node:child_process");',
        "const home = process.env.HOME;",
        "if (!home) process.exit(0);",
        // The directory this session works in, for the answers that are about
        // the FOLDER rather than about the tool. Empty where there is no
        // worktree - a sign-in container - and an answer needing it is skipped
        // there rather than written under a key still spelling the placeholder.
        'const workdir = process.env.POLARIS_WORKDIR || "";',
        // Deep, because one of these answers is two levels down, and the rule
        // holds at every level: a theme somebody has chosen keeps its value.
        //
        // `assert` is the difference between filling in what a file does not say
        // and writing what is Polaris's to say - the wizard itself, which only
        // an agent on a screen nobody could reach can have answered already. See
        // `CLAUDE_WIZARD_ANSWER`.
        // What marks a hook entry as one Polaris wrote: the relay names the
        // session's state directory, and nothing a person writes does - or,
        // for a tool that runs a hook by path, the path is one of Polaris's
        // relay scripts.
        'const ours = (value) => { const text = JSON.stringify(value); return text.includes("POLARIS_STATE_DIR") || text.includes("polaris-hooks"); };',
        // A path inside the worktree, in a value: `{workdir}/` at the start of a
        // string is the session's checkout (a hook script run by path).
        `const inCheckout = (value) => JSON.parse(JSON.stringify(value), (key, leaf) => typeof leaf === "string" && leaf.startsWith(${JSON.stringify(HOOK_FILE_WORKDIR)}) ? path.join(workdir, leaf.slice(${HOOK_FILE_WORKDIR.length})) : leaf);`,
        // The lines Polaris keeps inside a file it cannot parse (TOML), between
        // two markers, replaced in place; what is around them stays as it was.
        // Ported from replaceVibeManagedBlock / joinVibeTOML in Agent
        // Orchestrator's adapters/agent/vibe/hooks.go.
        `const BLOCK_START = ${JSON.stringify(HOOK_BLOCK_START)};`,
        `const BLOCK_END = ${JSON.stringify(HOOK_BLOCK_END)};`,
        "function withBlock(existing, body) {",
        '    const block = BLOCK_START + "\\n\\n" + body.replace(/\\n*$/, "\\n") + BLOCK_END + "\\n";',
        '    let prefix = existing, suffix = "";',
        "    const start = existing.indexOf(BLOCK_START);",
        "    if (start >= 0) {",
        "        prefix = existing.slice(0, start);",
        "        const end = existing.indexOf(BLOCK_END, start + BLOCK_START.length);",
        "        if (end >= 0) suffix = existing.slice(end + BLOCK_END.length);",
        "    }",
        '    prefix = prefix.replace(/\\n+$/, "");',
        '    suffix = suffix.replace(/^\\n+/, "");',
        '    return (prefix ? prefix + "\\n\\n" : "") + block + (suffix ? "\\n" + suffix : "");',
        "}",
        // A hook file the tool reads from the checkout rather than the home:
        // kept out of every commit the agent makes. Untracked, it goes into
        // the clone's own exclude list; tracked (a repository that ships its
        // own copy), git is told to leave our edit out of what it stages.
        "function keepOutOfCommits(rel) {",
        "    const git = (args) => execFileSync(\"git\", [\"-C\", workdir, ...args], { stdio: [\"ignore\", \"pipe\", \"ignore\"], windowsHide: true }).toString().trim();",
        "    try {",
        "        try { git([\"ls-files\", \"--error-unmatch\", \"--\", rel]); git([\"update-index\", \"--skip-worktree\", \"--\", rel]); return; } catch {}",
        "        const exclude = path.resolve(workdir, git([\"rev-parse\", \"--git-path\", \"info/exclude\"]));",
        '        let text = "";',
        '        try { text = fs.readFileSync(exclude, "utf8"); } catch {}',
        '        const line = "/" + rel;',
        '        if (text.split("\\n").includes(line)) return;',
        "        fs.mkdirSync(path.dirname(exclude), { recursive: true });",
        '        fs.appendFileSync(exclude, (text && !text.endsWith("\\n") ? "\\n" : "") + line + "\\n");',
        "    } catch {}",
        "}",
        "function fill(target, source, assert) {",
        "    let wrote = false;",
        "    for (const [name, value] of Object.entries(source)) {",
        `        const key = name === ${JSON.stringify(FIRST_RUN_WORKDIR)} ? workdir : name;`,
        "        if (!key) continue;",
        // A list is a value like any other: a hook registration is replaced
        // whole, never merged index by index into whatever list was there -
        // except that an asserted list of Polaris's hooks keeps the entries
        // Polaris did not write, so a repository's or a person's own hook for
        // the same event still runs beside ours.
        "        if (assert && Array.isArray(value) && ours(value) && Array.isArray(target[key])) {",
        "            const merged = target[key].filter((entry) => !ours(entry)).concat(value);",
        "            if (JSON.stringify(merged) !== JSON.stringify(target[key])) { target[key] = merged; wrote = true; }",
        "            continue;",
        "        }",
        '        if (value && typeof value === "object" && !Array.isArray(value)) {',
        "            const branch = target[key];",
        '            if (branch && typeof branch === "object" && !Array.isArray(branch)) {',
        "                if (fill(branch, value, assert)) wrote = true;",
        // A branch that is not there yet is filled aside and attached only if
        // something reached a leaf inside it, so an answer skipped for want of a
        // worktree leaves no empty `projects: {}` behind in the tool's own file.
        //
        // One that IS there but is not an object - `null`, a list, a number - is
        // left alone where the rule is to fill in, and replaced where the answer
        // is Polaris's to give. Walking away from it there would be the answer
        // never written and nothing said about it, which is the exact failure
        // `assert` exists to end, reached from a different starting state.
        "            } else if (branch === undefined || assert) {",
        "                const fresh = {};",
        "                if (fill(fresh, value, assert)) { target[key] = fresh; wrote = true; }",
        "            }",
        // Written when the file is silent, or when it says something else and this
        // is an answer Polaris gives. Never when it already agrees, so a session
        // with nothing to do writes nothing and prints nothing.
        "        } else if (target[key] === undefined || (assert && JSON.stringify(target[key]) !== JSON.stringify(value))) {",
        "            target[key] = value; wrote = true;",
        "        }",
        "    }",
        "    return wrote;",
        "}",
        'for (const answer of JSON.parse(fs.readFileSync(process.argv[1], "utf8"))) {',
        `    const inWorkdir = answer.file.startsWith(${JSON.stringify(HOOK_FILE_WORKDIR)});`,
        // No worktree (a sign-in container): nothing to hook there.
        "    if (inWorkdir && !workdir) continue;",
        `    const rel = inWorkdir ? answer.file.slice(${HOOK_FILE_WORKDIR.length}) : answer.file;`,
        "    const file = path.join(inWorkdir ? workdir : home, rel);",
        // A file that is not JSON: one Polaris owns whole (a relay script, a
        // plugin), or a block of lines in one that is somebody else's (TOML).
        // A file of the same name that Polaris did not write is left alone and
        // said so, never overwritten.
        '    if (typeof answer.text === "string" || typeof answer.block === "string") {',
        "        let existing = null;",
        '        try { existing = fs.readFileSync(file, "utf8"); } catch {}',
        '        if (typeof answer.text === "string" && existing !== null && !existing.includes("POLARIS_STATE_DIR")) {',
        '            console.log("polaris: left " + file + " as it was; it is not one Polaris wrote");',
        "            continue;",
        "        }",
        '        const next = typeof answer.text === "string" ? answer.text : withBlock(existing || "", answer.block);',
        "        try {",
        "            if (existing !== next) {",
        "                fs.mkdirSync(path.dirname(file), { recursive: true });",
        "                fs.writeFileSync(file, next);",
        "                if (inWorkdir) keepOutOfCommits(rel);",
        '                console.log("polaris: answered its first run in " + file);',
        "            }",
        "            if (answer.executable) fs.chmodSync(file, 0o755);",
        "        } catch (error) {",
        '            console.log("polaris: could not write " + file + " (" + error.message + ")");',
        "        }",
        "        continue;",
        "    }",
        "    let current = {};",
        // A file that is not there, or is half-written, is answered the same way
        // as an empty one. The alternative is a session that will not start
        // because a cache file the tool owns had a byte out of place.
        '    try { current = JSON.parse(fs.readFileSync(file, "utf8")); } catch { current = {}; }',
        '    if (!current || typeof current !== "object" || Array.isArray(current)) current = {};',
        "    let changed = answer.json ? fill(current, inCheckout(answer.json), false) : false;",
        "    if (answer.assert && fill(current, inCheckout(answer.assert), true)) changed = true;",
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
        "        if (inWorkdir) keepOutOfCommits(rel);",
        '        console.log("polaris: answered its first run in " + file);',
        "    } catch (error) {",
        '        console.log("polaris: could not write " + file + " (" + error.message + ")");',
        "    }",
        "}"
    ].join("\n");
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
 * What is somebody's to choose is filled in only where the file is silent, at
 * every level of nesting: a person who opens the session and picks a light theme
 * keeps it. The wizard's own answers are asserted instead - written whatever the
 * file says - because the only thing that can have answered one of those already
 * is an agent that met the screen before Polaris knew to. Which answer takes
 * which rule is declared in `AGENT_CLIS`; see `CLAUDE_WIZARD_ANSWER` for why the
 * two are not the same question.
 *
 * One of these questions is not about the tool but about the checkout: Claude
 * Code's workspace-trust dialog, which defaults to "No, exit" on a folder it has
 * never seen and is recorded per project path rather than as a flag at the top
 * of the file. `FIRST_RUN_WORKDIR` stands in for that path in the answer, and is
 * replaced here with the session's own worktree - or the answer is left out
 * entirely where there is no worktree yet, such as a sign-in container.
 */
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

/**
 * What Claude Code is told about the preview, appended to its system prompt
 * where the session has one (`POLARIS_PREVIEW_BASE`). Without it the agent
 * binds its servers to localhost, which nothing outside the container reaches,
 * and starts a framework at the root, whose page then asks for its scripts at
 * Polaris's root.
 *
 * Placed inside double quotes in the launch line and read again by `sh -c`, so
 * it holds no double quote, dollar sign, backtick or backslash of its own; the
 * one variable in it is expanded when the line is built.
 */
export const PREVIEW_PROMPT =
    "Polaris shows the web servers this session runs in a Preview tab beside the chat. " +
    "Bind a server to 0.0.0.0, not localhost, or the preview cannot reach it. " +
    "Port N opens at the path ${POLARIS_PREVIEW_BASE}/N/ of the Polaris address. " +
    "A plain server works as it is; when a framework dev server needs a base path to run under a path " +
    "(Vite --base, Next.js basePath, Astro base), start it with that path. " +
    "Hot reload does not reach the preview, which is reloaded from its tab.";

/**
 * The agent's credentials as Polaris resolved them for the coming turn, in the
 * state directory beside the checkout.
 *
 * The boot environment is fixed the moment the machine starts, and every turn
 * and every relaunch inherits it - so a session started before somebody linked
 * their account again kept the old credential until it ended. Polaris rewrites
 * this file before each prompt from the accounts as they are now, and the launch
 * script reads it right before the agent starts. Shell, because the launch
 * sources it: it clears every variable the tool reads first, so a credential
 * that is gone is gone rather than inherited from the boot.
 */
export const CREDENTIALS_FILE = "credentials.env";

/** The line the launch script reads that file with. Also what a launch script
 *  written by an older build is taught, so its sessions refresh too. */
const READ_CREDENTIALS = `if [ -f "$POLARIS_STATE_DIR/${CREDENTIALS_FILE}" ]; then . "$POLARIS_STATE_DIR/${CREDENTIALS_FILE}"; fi`;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The credentials file's contents: every name in `cleared` and `env` unset,
 * then `env` set and exported. Throws on a name that is not a variable or a
 * value with a control character, the same rule the boot environment is held
 * to, naming the variable and never the value.
 */
export function credentialsFileBody(
    cleared: readonly string[],
    env: Readonly<Record<string, string>>
): string {
    const names = [...new Set([...cleared, ...Object.keys(env)])];
    for (const name of names) {
        if (!ENV_NAME.test(name)) throw new Error(`Polaris will not write a credential named ${name}.`);
    }
    for (const [name, value] of Object.entries(env)) {
        if (hasControlCharacter(value))
            throw new Error(`Polaris built an unusable value for ${name} and kept the session's own.`);
    }
    const set = Object.keys(env);
    return [
        "# Written by Polaris before each turn: this session's agent credentials as they are now.",
        ...(names.length > 0 ? [`unset ${names.join(" ")}`] : []),
        ...Object.entries(env).map(([name, value]) => `${name}=${shellQuote(value)}`),
        ...(set.length > 0 ? [`export ${set.join(" ")}`] : []),
        ""
    ].join("\n");
}

const PART_NAME = /^credentials\.[a-f0-9]{8,64}\.part$/;

/**
 * Put a credentials file written beside its final name (`part`) in place:
 * private, owned like the state directory, and renamed so the launch never
 * reads half of one. A launch script from an older build is taught to read it
 * first. Carries no value, so it can travel as an argument. Exits 0 without
 * doing anything where there is no launch script - a session still booting,
 * or a state directory that is not there.
 */
export function installCredentialsCommand(stateDir: string, part: string): string {
    if (!PART_NAME.test(part)) throw new Error("That is not a credentials file Polaris wrote.");
    const read = Buffer.from(READ_CREDENTIALS, "utf8").toString("base64");
    return [
        `d="${stateDir}"`,
        `p="$d/${part}"`,
        'if [ ! -f "$d/launch.sh" ]; then rm -f "$p"; exit 0; fi',
        `if ! grep -q ${CREDENTIALS_FILE} "$d/launch.sh"; then`,
        `  if { head -n 1 "$d/launch.sh"; printf %s ${read} | base64 -d; echo; tail -n +2 "$d/launch.sh"; } > "$d/launch.sh.part" && chmod 0755 "$d/launch.sh.part"; then mv "$d/launch.sh.part" "$d/launch.sh"; else rm -f "$d/launch.sh.part"; fi`,
        "fi",
        'chmod 0600 "$p" || { rm -f "$p"; exit 1; }',
        'chown "$(stat -c %u:%g "$d" 2>/dev/null)" "$p" 2>/dev/null || true',
        `mv "$p" "$d/${CREDENTIALS_FILE}"`
    ].join("\n");
}

/**
 * Write a credentials file and put it in place, as one script for a machine
 * reached over SSH, where the script travels on standard input and never on a
 * command line. Nothing is written where there is no state directory.
 */
export function writeCredentialsCommand(stateDir: string, part: string, body: string): string {
    const encoded = Buffer.from(body, "utf8").toString("base64");
    return [
        `[ -d "${stateDir}" ] || exit 0`,
        "umask 077",
        `printf %s ${encoded} | base64 -d > "${stateDir}/${part}" || exit 1`,
        installCredentialsCommand(stateDir, part)
    ].join("\n");
}

/**
 * Starts the agent, or reopens one of its conversations.
 *
 * A file rather than lines in the setup, so anything that has to start the agent
 * again later - from the shell the window falls back to once the agent has
 * exited - starts the same agent the same way the boot did. There is one copy. Fixed text - every value arrives in the environment the
 * boot exported, and the one argument is checked before it is used.
 *
 * Not as root. These tools refuse their own skip-permissions flag when they are
 * running as root - deliberately, and they are right to - so an agent started as
 * root refused, exited in the same second, and took the window with it. The
 * container is root because installing packages needs it, so the installing
 * happens as root and the agent does not. It keeps sudo: the point is not to
 * take privileges away, it is to not BE root while holding them.
 *
 * Run rather than exec by its caller, with a shell afterwards: an agent that
 * exited for any reason must not take the window, and every word explaining why,
 * with it.
 */
/** Beside the checkout when the boot found the tool refuses its `hookArgs`. */
export const HOOK_ARGS_REFUSED_FILE = "hook-args-refused";

export const LAUNCH_SCRIPT = [
    "#!/bin/sh",
    "# Written by Polaris. Starts this session's agent; an argument reopens that conversation.",
    "# --turn <file> runs the prompt in that file without the agent's interface, on the conversation its hooks last named.",
    READ_CREDENTIALS,
    // The session's own tools first: its `gh`, which mints its token per run.
    'if [ -d "$POLARIS_STATE_DIR/bin" ]; then PATH="$POLARIS_STATE_DIR/bin:$PATH"; export PATH; fi',
    'turn=""',
    'if [ "${1:-}" = "--turn" ]; then',
    '  turn="${2:-}"',
    '  id="$(head -c 128 "$POLARIS_STATE_DIR/agent-session-id" 2>/dev/null || true)"',
    '  case "$id" in *[!A-Za-z0-9_-]*) id="" ;; esac',
    "else",
    '  id="${1:-}"',
    "fi",
    'case "$id" in *[!A-Za-z0-9_-]*) echo "polaris: that is not a conversation Polaris can reopen"; exit 1 ;; esac',
    'line="$POLARIS_AGENT_COMMAND"',
    'if [ -n "$turn" ]; then line="$line $POLARIS_AGENT_HEADLESS"; fi',
    'if [ -n "$id" ]; then',
    '  case "$POLARIS_AGENT_RESUME" in',
    '    flag) line="$line --resume $id" ;;',
    '    subcommand) line="$POLARIS_AGENT_BINARY resume $id${POLARIS_AGENT_COMMAND#"$POLARIS_AGENT_BINARY"}" ;;',
    '    *) id="" ;;',
    "  esac",
    "fi",
    // The extension or agent that reports this session's activity, unless the
    // boot found this build refuses it (see the probe before the launch).
    `if [ -n "$POLARIS_AGENT_HOOK_ARGS" ] && [ ! -e "$POLARIS_STATE_DIR/${HOOK_ARGS_REFUSED_FILE}" ]; then line="$line $POLARIS_AGENT_HOOK_ARGS"; fi`,
    // A fork's first start reopens its parent's conversation as a new one of its
    // own. Once: the marker is beside the checkout, so a later start - after the
    // agent exited - is this session's own conversation rather than a second fork.
    'if [ -z "$id" ] && [ -n "${POLARIS_AGENT_FORK:-}" ] && [ ! -e "$POLARIS_STATE_DIR/forked" ] && [ -f "$POLARIS_AGENT_FORK" ]; then',
    '  case "$POLARIS_AGENT_FORK" in *[!A-Za-z0-9_./-]*) ;; *) line="$line --resume $POLARIS_AGENT_FORK --fork-session"; : > "$POLARIS_STATE_DIR/forked" ;; esac',
    "fi",
    // Through Enigma where Polaris asked for it AND Enigma is actually here: the
    // install that put it there is best effort, and a launcher that did not
    // arrive falls back to the tool itself.
    'if [ -n "$POLARIS_AGENT_LAUNCHER" ] && command -v "$POLARIS_AGENT_LAUNCHER" >/dev/null 2>&1; then',
    '  line="$POLARIS_AGENT_LAUNCHER $line"',
    "fi",
    // The hooks and the Polaris tools, from beside the checkout rather than from
    // the repository's own .claude and .mcp.json. See PREPARE_WORKTREE.
    'if [ "$POLARIS_AGENT_CONFIG" = "claude" ]; then',
    // A mode changed mid-session (see permissionModeCommand): the next start
    // takes it. Last on the line, so it outranks the one the boot gave.
    '  m="$(head -c 40 "$POLARIS_STATE_DIR/permission-mode" 2>/dev/null || true)"',
    '  case "$m" in default|acceptEdits|plan|bypassPermissions) line="$line --permission-mode $m" ;; esac',
    // A model changed mid-session (see modelCommand), last for the same reason.
    // The flag outranks ANTHROPIC_MODEL, which is how the boot named one.
    '  m="$(head -c 200 "$POLARIS_STATE_DIR/model" 2>/dev/null || true)"',
    // Quoted on the line: an id like `sonnet[1m]` is otherwise a glob.
    `  if printf %s "$m" | grep -Eq '^[A-Za-z0-9][][A-Za-z0-9._:/@-]{0,199}$'; then line="$line --model '$m'"; fi`,
    // An effort changed mid-session (see effortCommand), last for the same
    // reason: the later `--effort` outranks the one the boot gave.
    '  m="$(head -c 10 "$POLARIS_STATE_DIR/effort" 2>/dev/null || true)"',
    '  case "$m" in low|medium|high|xhigh|max) line="$line --effort $m" ;; esac',
    '  line="$line --settings \\"$POLARIS_STATE_DIR/settings.json\\" --mcp-config \\"$POLARIS_STATE_DIR/mcp.json\\""',
    `  if [ -n "\${POLARIS_PREVIEW_BASE:-}" ]; then line="$line --append-system-prompt \\"${PREVIEW_PROMPT}\\""; fi`,
    "fi",
    'if [ -n "$turn" ]; then :; elif [ -n "$id" ]; then echo "polaris: starting $POLARIS_AGENT_COMMAND on conversation $id"; else echo "polaris: starting $POLARIS_AGENT_COMMAND"; fi',
    // Written last, so anything holding a prompt knows the terminal it is about
    // to type into belongs to the agent rather than to the installer.
    `: > ${AGENT_READY_FLAG}`,
    `chmod 0666 ${AGENT_READY_FLAG} 2>/dev/null || true`,
    'cd "$POLARIS_WORKDIR"',
    // A turn reads its prompt from the file, so no part of it is ever a shell
    // word or a keystroke.
    'if [ -n "$turn" ]; then line="$line < \\"$turn\\""; fi',
    'if [ "$POLARIS_AS_ROOT" = "yes" ]; then',
    '  su -p "$POLARIS_RUNAS" -c "cd \\"$POLARIS_WORKDIR\\" && $line"',
    "else",
    '  sh -c "cd \\"$POLARIS_WORKDIR\\" && $line"',
    "fi",
    ""
].join("\n");

/** The tmux window a person opens the agent's own interface in, beside the
 *  runner. While it is open, prompts go to it rather than to the runner. */
export const INTERFACE_WINDOW = "polaris-tui";

/** The window the runner names itself, so an interrupt reaches it by name. */
export const RUNNER_WINDOW = "polaris-runner";

/** Written by the runner once it is taking prompts. Beside the checkout, so it
 *  says which way this session's prompts go even after a container restart. */
export const RUNNER_READY_FILE = "runner.ready";

/**
 * The runner: takes each prompt Polaris queues and runs it as one turn without
 * the agent's interface, one at a time, in order.
 *
 * A prompt is a file in `prompts/`, written whole and renamed into place, so
 * nothing is ever typed into a terminal and nothing has to look ready first.
 * The turn's own hooks report what happens, as an interactive agent's do; the
 * runner adds only what they cannot: a turn that exited on an error (the tool
 * signed out, a refused key) and one stopped by Polaris, so neither leaves the
 * session on "Working".
 *
 * Ctrl-C reaches the turn and not the runner, which traps it. While a person has
 * the interface open (`INTERFACE_WINDOW`), it waits, so two processes never
 * write the same conversation.
 */
export const RUNNER_SCRIPT = [
    "#!/bin/sh",
    "# Written by Polaris. Runs each prompt Polaris queues, one at a time, without the agent's interface.",
    'd="$POLARIS_STATE_DIR"',
    'q="$d/prompts"',
    'mkdir -p "$q"',
    // A turn a restart cut short is not picked up again half done.
    'rm -f "$d/turn.txt" "$d/interrupted"',
    "trap 'echo \"polaris: stopped\"' INT",
    `tmux rename-window -t "\${TMUX_PANE:-}" ${RUNNER_WINDOW} 2>/dev/null || true`,
    `: > "$d/${RUNNER_READY_FILE}"`,
    `: > ${AGENT_READY_FLAG}`,
    `chmod 0666 ${AGENT_READY_FLAG} 2>/dev/null || true`,
    'echo "polaris: ready. Prompts from Polaris run here, one at a time."',
    "while :; do",
    `  if tmux list-windows -t "$POLARIS_TMUX" -F '#{window_name}' 2>/dev/null | grep -qx ${INTERFACE_WINDOW}; then sleep 1; continue; fi`,
    '  next="$(ls "$q" 2>/dev/null | grep -v "^\\." | head -n 1)"',
    // A fifth of a second: a whole second here was up to a second of every
    // prompt spent waiting for the runner to look again.
    '  if [ -z "$next" ]; then sleep 0.2; continue; fi',
    '  mv "$q/$next" "$d/turn.txt" 2>/dev/null || { sleep 1; continue; }',
    '  chmod 0644 "$d/turn.txt" 2>/dev/null || true',
    '  rm -f "$d/turn.rc" "$d/interrupted"',
    '  echo "polaris: working on a prompt"',
    '  { sh "$d/launch.sh" --turn "$d/turn.txt" 2>&1; echo $? > "$d/turn.rc"; } | tee "$d/turn.log"',
    '  rc="$(cat "$d/turn.rc" 2>/dev/null || echo 1)"',
    '  if [ -f "$d/interrupted" ]; then',
    `    printf '{"hook_event_name":"Stop"}' | sh "$d/hook.sh" >/dev/null 2>&1 || true`,
    '  elif [ "$rc" != "0" ]; then',
    // The last line the tool printed, as words for the session: no control
    // characters, quotes or backslashes, so it is a JSON string as it stands.
    `    said="$(tail -n 1 "$d/turn.log" 2>/dev/null | tr -d '\\000-\\037"\\\\' | cut -c1-300)"`,
    `    printf '{"hook_event_name":"StopFailure","error":"%s"}' "\${said:-The agent exited with status $rc}" | sh "$d/hook.sh" >/dev/null 2>&1 || true`,
    "  fi",
    '  rm -f "$d/turn.txt" "$d/interrupted"',
    "done",
    ""
].join("\n");

const RUNNER_SCRIPT_BASE64 = Buffer.from(RUNNER_SCRIPT, "utf8").toString("base64");

/** What the setup cleared before the agent started, cleared again by anything
 *  that starts it later from tmux's own environment, which is the boot's. */
const CLEAR_BOOT_ENV: readonly string[] = [
    "unset GIT_AUTH_HEADER POLARIS_HOOK_SCRIPT POLARIS_HOOK_SETTINGS POLARIS_MCP_CONFIG POLARIS_MEMORY_SYNC POLARIS_SKILLS_SYNC POLARIS_GIT_CREDENTIAL POLARIS_ENIGMA_SETUP POLARIS_ENIGMA_CONFIGURE POLARIS_FIRST_RUN POLARIS_REPO_SETUP POLARIS_AGENT_HOOK_FILE",
    'for pair in $POLARIS_CREDENTIAL_FILES; do unset "$(printf %s "$pair" | cut -d= -f1)"; done'
];

/**
 * What the interface window runs: the agent on the conversation the runner was
 * on. A window opened later starts from tmux's own environment, which is the
 * boot's, so what the setup cleared before the agent started is cleared again.
 */
export const INTERFACE_SCRIPT = [
    "#!/bin/sh",
    "# Written by Polaris. Opens the agent's own interface on this session's conversation.",
    ...CLEAR_BOOT_ENV,
    'id="$(head -c 128 "$POLARIS_STATE_DIR/agent-session-id" 2>/dev/null || true)"',
    'case "$id" in *[!A-Za-z0-9_-]*) id="" ;; esac',
    'exec sh "$POLARIS_STATE_DIR/launch.sh" "$id"',
    ""
].join("\n");

const INTERFACE_SCRIPT_BASE64 = Buffer.from(INTERFACE_SCRIPT, "utf8").toString("base64");

/** Whether this session runs its prompts through the runner, as a test a
 *  command can start with: a session booted before the runner existed has no
 *  marker and keeps its interactive terminal. */
function runnerIn(stateDir: string): string {
    return `[ -f "${stateDir}/${RUNNER_READY_FILE}" ]`;
}

/** Whether the agent's own interface is open in its window. */
function interfaceOpen(session = TMUX_SESSION): string {
    return `tmux list-windows -t ${shellQuote(session)} -F '#{window_name}' 2>/dev/null | grep -qx ${INTERFACE_WINDOW}`;
}

/** Whether the runner is up and taking prompts: the readiness question for a
 *  session that runs its turns without the interface. */
export function runnerReadyCommand(stateDir: string): string {
    return `${runnerIn(stateDir)} && test -f ${AGENT_READY_FLAG}`;
}

/** What `queuePromptCommand` exits with when the prompt is not queued. */
export const NOT_QUEUED = { interactive: 3, interfaceOpen: 4 } as const;

/**
 * Hand the runner a prompt: written aside, then renamed into the queue, so the
 * runner never reads half of one. Exits `NOT_QUEUED.interactive` for a session
 * with no runner and `NOT_QUEUED.interfaceOpen` while the interface is open;
 * both are typed into the terminal instead.
 *
 * The state directory is Polaris's own path (`$HOME` on a server, which the
 * shell expands), never anything a person typed. The prompt travels as base64.
 */
export function queuePromptCommand(stateDir: string, text: string): string {
    const encoded = Buffer.from(text, "utf8").toString("base64");
    return [
        `${runnerIn(stateDir)} || exit ${NOT_QUEUED.interactive}`,
        `${interfaceOpen()} && exit ${NOT_QUEUED.interfaceOpen}`,
        `q="${stateDir}/prompts"`,
        'mkdir -p "$q"',
        'n="$(date +%s%N 2>/dev/null)"',
        'case "$n" in *N|"") n="$(date +%s)000000000" ;; esac',
        'n="$n-$$"',
        `printf %s ${encoded} | base64 -d > "$q/.$n"`,
        'mv "$q/.$n" "$q/$n"'
    ].join("\n");
}

/**
 * Claude Code's Shift+Tab cycle over the modes Polaris offers: `default`, then
 * `acceptEdits`, then `plan`, then `bypassPermissions`, which is in the cycle
 * because Polaris starts Claude Code with `--allow-dangerously-skip-permissions`
 * (https://code.claude.com/docs/en/permission-modes). A mode the person
 * enabled beyond these (`auto`) slots in after them, so a press count read off
 * this can land there; the next hook reports the mode in force either way.
 */
export const CLAUDE_MODE_CYCLE = ["ask", "edits", "plan", "full"] as const;

/** How many Shift+Tab presses move the agent from one mode to another. */
export function modePresses(from: string | null, to: string): number {
    const cycle: readonly string[] = CLAUDE_MODE_CYCLE;
    const start = cycle.indexOf(from ?? "");
    const end = cycle.indexOf(to);
    if (start < 0 || end < 0) return 0;
    return (end - start + cycle.length) % cycle.length;
}

/**
 * Change a running Claude session's permission mode.
 *
 * The mode is written beside the checkout, where the launch script reads it,
 * so a session that runs each prompt as its own turn takes it from the next
 * one. One with the agent's interface open is switched where it stands, with
 * the same Shift+Tab presses a person would make - only when it is idle at its
 * prompt, which the caller checks, because at a plan approval Shift+Tab
 * approves.
 */
export function permissionModeCommand(stateDir: string, claudeMode: string, presses: number): string {
    if (!/^[A-Za-z]+$/.test(claudeMode)) throw new Error("not a permission mode");
    const keys = Array.from({ length: Math.max(0, Math.min(presses, 6)) }, () => "BTab").join(" ");
    return [
        `printf %s ${claudeMode} > "${stateDir}/permission-mode"`,
        `if ${runnerIn(stateDir)} && ! ${interfaceOpen()}; then exit 0; fi`,
        keys
            ? `t=${shellQuote(TMUX_SESSION)}; if ${interfaceOpen()}; then t=${shellQuote(`${TMUX_SESSION}:${INTERFACE_WINDOW}`)}; fi; tmux send-keys -t "$t" ${keys}`
            : ":"
    ].join("\n");
}

/**
 * Change a running Claude session's model.
 *
 * Like the mode, written beside the checkout for the launch script, so a session
 * that runs each prompt as its own turn takes it from the next one. One with the
 * agent's interface open is told where it stands with `/model <id>`, which
 * Claude Code takes without opening its picker - only when it is idle at its
 * prompt, which the caller checks. The id is held to SAFE_MODEL_ID here because
 * it is about to be a word on a command line.
 */
export function modelCommand(stateDir: string, model: string): string {
    if (!SAFE_MODEL_ID.test(model)) throw new Error("not a model id");
    const target = `${TMUX_SESSION}:${INTERFACE_WINDOW}`;
    return [
        `printf %s ${shellQuote(model)} > "${stateDir}/model"`,
        `if ${runnerIn(stateDir)} && ! ${interfaceOpen()}; then exit 0; fi`,
        `t=${shellQuote(TMUX_SESSION)}; if ${interfaceOpen()}; then t=${shellQuote(target)}; fi`,
        `tmux send-keys -t "$t" -l ${shellQuote(`/model ${model}`)}`,
        'tmux send-keys -t "$t" Enter'
    ].join("\n");
}

/**
 * Change a running Claude session's effort, as `modelCommand` changes its
 * model: kept in the state dir for the next start, and typed into the terminal
 * now when nothing else holds it. `level` is held to the known levels here.
 */
export function effortCommand(stateDir: string, command: string, level: string): string {
    if (!isAgentEffortLevel(level) || !/^\/[a-z-]+$/.test(command)) throw new Error("not an effort level");
    const target = `${TMUX_SESSION}:${INTERFACE_WINDOW}`;
    return [
        `printf %s ${shellQuote(level)} > "${stateDir}/effort"`,
        `if ${runnerIn(stateDir)} && ! ${interfaceOpen()}; then exit 0; fi`,
        `t=${shellQuote(TMUX_SESSION)}; if ${interfaceOpen()}; then t=${shellQuote(target)}; fi`,
        `tmux send-keys -t "$t" -l ${shellQuote(`${command} ${level}`)}`,
        'tmux send-keys -t "$t" Enter'
    ].join("\n");
}

/** Stop the turn the runner is on, leaving the runner and the session up.
 *  Exits `NOT_QUEUED.interactive` for a session with no runner. */
export function interruptTurnCommand(stateDir: string): string {
    return [
        `${runnerIn(stateDir)} || exit ${NOT_QUEUED.interactive}`,
        `[ -f "${stateDir}/turn.txt" ] || exit 0`,
        `: > "${stateDir}/interrupted"`,
        `tmux send-keys -t ${shellQuote(`${TMUX_SESSION}:${RUNNER_WINDOW}`)} C-c`
    ].join("\n");
}

/** What `openInterfaceCommand` exits with when it opens nothing. */
export const NOT_OPENED = { interactive: 3, turnRunning: 4 } as const;

/**
 * Open the agent's own interface in a window beside the runner, on the same
 * conversation, or bring it forward when it is already open. Not while a turn
 * is running: two processes on one conversation would each write over the
 * other. The id is checked here because it is about to be part of a command.
 */
export function openInterfaceCommand(stateDir: string, session = TMUX_SESSION): string {
    return [
        `${runnerIn(stateDir)} || exit ${NOT_OPENED.interactive}`,
        `if ${interfaceOpen(session)}; then tmux select-window -t ${shellQuote(`${session}:${INTERFACE_WINDOW}`)}; exit 0; fi`,
        `[ -f "${stateDir}/turn.txt" ] && exit ${NOT_OPENED.turnRunning}`,
        `tmux new-window -t ${shellQuote(session)} -n ${INTERFACE_WINDOW} "sh \\"${stateDir}/interface.sh\\""`
    ].join("\n");
}

/**
 * What a restarted agent's pane runs: the agent on its conversation, with the
 * boot's environment cleared as the setup cleared it, and as the agent's own
 * account where the setup would have dropped to it. `window` for the
 * interface window, which closes when the agent exits so the runner carries
 * on; otherwise the terminal is left at a shell, as the boot leaves it.
 */
export const RELAUNCH_SCRIPT = [
    "#!/bin/sh",
    "# Written by Polaris. Starts the agent again on its conversation, on the account its session moved to.",
    ...CLEAR_BOOT_ENV,
    ...AGENT_ACCOUNT.slice(0, 4),
    "export POLARIS_AS_ROOT",
    'id="${1:-}"',
    'case "$id" in *[!A-Za-z0-9_-]*) id="" ;; esac',
    'if [ "${2:-}" = "window" ]; then exec sh "$POLARIS_STATE_DIR/launch.sh" "$id"; fi',
    'sh "$POLARIS_STATE_DIR/launch.sh" "$id" || true',
    'echo "polaris: the agent exited. This terminal is still yours."',
    "exec sh",
    ""
].join("\n");

const RELAUNCH_SCRIPT_BASE64 = Buffer.from(RELAUNCH_SCRIPT, "utf8").toString("base64");

/** What `relaunchAgentCommand` exits with when it restarts nothing. */
export const NOT_RELAUNCHED = { nextTurn: 3 } as const;

/** How long the agent is given to stop its turn after Esc, before its pane is
 *  restarted. */
export const RELAUNCH_SETTLE_SECONDS = 2;

/**
 * Restart the agent running in the session's terminal on its conversation, so
 * it starts again from the credentials file and reads the account the session
 * moved to: a running process keeps the variables it started with.
 *
 * The turn it is on ends first the way a person ends one, with Esc, which
 * Codex, Claude Code and Gemini CLI each take as "stop this turn" and record
 * in the conversation; only then is the pane restarted, on the same
 * conversation, so nothing it said is lost. The ready flag goes first, so
 * nothing types into the pane before the restarted agent holds it.
 *
 * Exits `NOT_RELAUNCHED.nextTurn` for a session whose runner starts every turn
 * afresh and whose interface is closed: its next turn reads the account. The
 * id is checked here because it is about to be part of a command.
 */
export function relaunchAgentCommand(stateDir: string, vendorSessionId: string, session = TMUX_SESSION): string {
    if (!isVendorSessionId(vendorSessionId)) throw new Error("That is not a conversation Polaris can reopen.");
    return [
        `if ${interfaceOpen(session)}; then t=${shellQuote(`${session}:${INTERFACE_WINDOW}`)}; m=window`,
        `elif ${runnerIn(stateDir)}; then exit ${NOT_RELAUNCHED.nextTurn}`,
        `else t=${shellQuote(session)}; m=terminal; fi`,
        `printf %s ${RELAUNCH_SCRIPT_BASE64} | base64 -d > "${stateDir}/relaunch.sh" || exit 1`,
        'tmux send-keys -t "$t" Escape',
        `sleep ${RELAUNCH_SETTLE_SECONDS}`,
        `rm -f ${AGENT_READY_FLAG}`,
        `tmux respawn-pane -k -t "$t" "sh \\"${stateDir}/relaunch.sh\\" ${vendorSessionId} $m"`
    ].join("\n");
}

/** Clear the ready flag before typing a resume into the shell the agent left,
 *  so a turn typed after it waits for the agent rather than the shell. */
export function clearReadyCommand(): string {
    return `rm -f ${AGENT_READY_FLAG}`;
}

/** Whether a restarted or resumed agent holds its pane again: the interface
 *  window when it is open, else the terminal. */
export function relaunchedReadyCommand(session = TMUX_SESSION): string {
    return `if ${interfaceOpen(session)}; then ${agentReadyCommand(`${session}:${INTERFACE_WINDOW}`)}; else ${agentReadyCommand(session)}; fi`;
}

/** Left in the state directory of a container kept for its unsaved work, whose
 *  session is over. A reboot of the box restarts that container too, and the
 *  boot then opens a terminal on the work instead of starting the agent again. */
export const SESSION_ENDED_FILE = "ended";

const LAUNCH_SCRIPT_BASE64 = Buffer.from(LAUNCH_SCRIPT, "utf8").toString("base64");

/** Where the answers land on the way in. Beside the other scripts the setup
 *  writes and removes, and holding nothing secret - the tool's own defaults. */
const FIRST_RUN_FILE = "$(printenv TMPDIR || echo /tmp)/polaris-first-run.json";

/**
 * The repository's own setup script - installing dependencies, seeding a
 * database - run in the fresh checkout before the agent starts, in the window
 * somebody watching the session sees.
 *
 * Once per checkout: a marker beside it says it passed, so a machine that
 * restarts under a session does not install everything again, and one whose
 * setup failed tries again. Run without the clone credential, which is still in
 * the environment at this point and is not the repository's to read. A failure
 * stops the session only where the repository asked for that; otherwise it is
 * said and the agent starts anyway.
 */
export const REPO_SETUP = [
    'if [ -n "$POLARIS_REPO_SETUP" ] && [ ! -f "$POLARIS_STATE_DIR/setup-done" ]; then',
    '  echo "polaris: running the repository setup script"',
    '  printf %s "$POLARIS_REPO_SETUP" | base64 -d > "$POLARIS_STATE_DIR/repo-setup.sh"',
    '  chmod 0755 "$POLARIS_STATE_DIR/repo-setup.sh"',
    '  if (unset GIT_AUTH_HEADER POLARIS_GIT_CREDENTIAL POLARIS_ENIGMA_SETUP POLARIS_ENIGMA_CONFIGURE POLARIS_REPO_SETUP; cd "$POLARIS_WORKDIR" && as_agent "sh \\"$POLARIS_STATE_DIR/repo-setup.sh\\""); then',
    '    touch "$POLARIS_STATE_DIR/setup-done"',
    '    echo "polaris: the setup script finished"',
    '  elif [ "$POLARIS_REPO_SETUP_REQUIRED" = "yes" ]; then',
    '    echo "polaris: the setup script failed, and this repository needs it to pass. The agent was not started. This terminal is yours."',
    "    exec sh",
    "  else",
    '    echo "polaris: the setup script failed. The agent starts anyway."',
    "  fi",
    "fi"
];

const START_AGENT = [
    // Enigma's own settings, into the home the agent reads - the skills, the
    // memory file, the commands, the trust and bypass settings.
    //
    // Before the unset below, which is where this used to be and is why none of
    // it ever ran: the variable was cleared two lines above the `if` that tested
    // it, so every session installed Enigma and then configured nothing.
    'if [ -n "$POLARIS_ENIGMA_CONFIGURE" ]; then',
    '  printf %s "$POLARIS_ENIGMA_CONFIGURE" | base64 -d > $(printenv TMPDIR || echo /tmp)/polaris-enigma.sh',
    "  chmod 0755 $(printenv TMPDIR || echo /tmp)/polaris-enigma.sh",
    '  as_agent "sh $(printenv TMPDIR || echo /tmp)/polaris-enigma.sh" || true',
    "  rm -f $(printenv TMPDIR || echo /tmp)/polaris-enigma.sh",
    "fi",
    // A login the tool keeps in a file of its own (Codex, Gemini CLI, Copilot
    // CLI), put back from Polaris's copy when the home has none - and only
    // then: these files hold refresh tokens the tool rotates, and an older copy
    // written over a newer one is a login that stops working. Each value is
    // base64 already, so it never carried a control character, and it leaves
    // the environment here either way.
    'for pair in $POLARIS_CREDENTIAL_FILES; do',
    '  name=$(printf %s "$pair" | cut -d= -f1)',
    '  rel=$(printf %s "$pair" | cut -d= -f2-)',
    '  value=$(printenv "$name" 2>/dev/null || true)',
    '  if [ -n "$value" ] && [ -n "$POLARIS_HOME" ] && [ ! -s "$POLARIS_HOME/$rel" ]; then',
    '    mkdir -p "$(dirname "$POLARIS_HOME/$rel")"',
    '    printf %s "$value" | base64 -d > "$POLARIS_HOME/$rel" 2>/dev/null || rm -f "$POLARIS_HOME/$rel"',
    '    chmod 0600 "$POLARIS_HOME/$rel" 2>/dev/null || true',
    '    if [ "$POLARIS_AS_ROOT" = "yes" ]; then',
    '      chown -R "$POLARIS_RUNAS" "$(dirname "$POLARIS_HOME/$rel")" 2>/dev/null || true',
    "    fi",
    "  fi",
    '  unset "$name"',
    "done",
    "unset value",
    // After Enigma, which writes into the same files, and before the launch,
    // which is the last moment anything can answer a question the tool is about
    // to ask on a screen nobody can reach. Only where Polaris owns the home.
    'if [ -n "$POLARIS_FIRST_RUN" ] && [ -n "$POLARIS_HOME" ]; then',
    '  printf %s "$POLARIS_FIRST_RUN" | base64 -d > $(printenv TMPDIR || echo /tmp)/polaris-first-run.sh',
    "  chmod 0755 $(printenv TMPDIR || echo /tmp)/polaris-first-run.sh",
    // Best effort, like everything else that prepares the home: a session that
    // has to answer its own theme menu is worse than one that does not start.
    '  as_agent "sh $(printenv TMPDIR || echo /tmp)/polaris-first-run.sh" || true',
    "  rm -f $(printenv TMPDIR || echo /tmp)/polaris-first-run.sh",
    "fi",
    // What the agent remembers about this repository, from whichever box last
    // ran a session of it, before the agent starts and reads it. After Enigma
    // and the first run, which write into the same home. Best effort: a
    // session that starts without its memory is better than one that does
    // not start, and the script uploads nothing until a restore succeeded.
    'if [ -f "$POLARIS_STATE_DIR/memory-sync.sh" ]; then',
    '  as_agent "sh \\"$POLARIS_STATE_DIR/memory-sync.sh\\" restore" || true',
    "fi",
    // The person's skills as they set them up in Polar - their own, the
    // built-ins they switched on, and their edits of Enigma's - written over
    // what Enigma installed, so after it. Best effort, like the memory.
    'if [ -f "$POLARIS_STATE_DIR/skills-sync.sh" ] && [ -n "$POLARIS_HOME" ]; then',
    '  as_agent "sh \\"$POLARIS_STATE_DIR/skills-sync.sh\\" \\"$POLARIS_HOME\\"" || true',
    "fi",
    "unset GIT_AUTH_HEADER",
    "unset POLARIS_HOOK_SCRIPT POLARIS_HOOK_SETTINGS POLARIS_MCP_CONFIG POLARIS_MEMORY_SYNC POLARIS_SKILLS_SYNC POLARIS_GIT_CREDENTIAL POLARIS_ENIGMA_SETUP POLARIS_ENIGMA_CONFIGURE POLARIS_FIRST_RUN POLARIS_REPO_SETUP POLARIS_AGENT_HOOK_FILE",
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
    // Said where somebody will read it, because nothing else advertises this: a
    // machine that keeps its home can hold several logins, and one command makes
    // the next one.
    'if [ -n "$POLARIS_AGENT_LAUNCHER" ] && command -v "$POLARIS_AGENT_LAUNCHER" >/dev/null 2>&1; then',
    "  echo \"polaris: this machine keeps its logins. 'enigma account add <name> --login' adds another, 'enigma account use <name>' picks it.\"",
    "fi",
    // The launch is a script beside the checkout rather than a line here, so a
    // later relaunch runs exactly what the boot ran. Exported, because the shell
    // left in the window after the agent exits is the one that runs it then.
    // A build that refuses the arguments loading the activity hook exits the
    // moment it is handed them (Prime Agent 0.10 and `--extension`), so where
    // the catalogue names a flag to look for, its help is read first and a
    // build that does not list it starts without them. Ported from
    // `acceptsExtension` in Agent Orchestrator's primeagent adapter: an
    // unreadable help keeps them. Bounded: ten seconds, 256 KiB.
    `rm -f "$POLARIS_STATE_DIR/${HOOK_ARGS_REFUSED_FILE}"`,
    'if [ -n "$POLARIS_AGENT_HOOK_ARGS" ] && [ -n "$POLARIS_AGENT_HOOK_PROBE" ] && command -v timeout >/dev/null 2>&1; then',
    '  help="$(cd "$POLARIS_WORKDIR" && as_agent "timeout 10 \\"$POLARIS_AGENT_BINARY\\" --help" </dev/null 2>&1 | head -c 262144)"',
    '  if [ -n "$help" ] && ! printf %s "$help" | grep -qF -e "$POLARIS_AGENT_HOOK_PROBE"; then',
    `    : > "$POLARIS_STATE_DIR/${HOOK_ARGS_REFUSED_FILE}"`,
    '    echo "polaris: this $POLARIS_AGENT_BINARY does not take $POLARIS_AGENT_HOOK_PROBE, so it starts without reporting what it is doing"',
    "  fi",
    "  unset help",
    "fi",
    "export POLARIS_AS_ROOT POLARIS_WORKDIR POLARIS_STATE_DIR",
    `printf %s ${LAUNCH_SCRIPT_BASE64} | base64 -d > "$POLARIS_STATE_DIR/launch.sh"`,
    'chmod 0755 "$POLARIS_STATE_DIR/launch.sh"',
    // The runner and the interface window, for a tool that runs a turn without
    // its interface. Written either way: a script nothing starts costs nothing.
    `printf %s ${RUNNER_SCRIPT_BASE64} | base64 -d > "$POLARIS_STATE_DIR/runner.sh"`,
    `printf %s ${INTERFACE_SCRIPT_BASE64} | base64 -d > "$POLARIS_STATE_DIR/interface.sh"`,
    'chmod 0755 "$POLARIS_STATE_DIR/runner.sh" "$POLARIS_STATE_DIR/interface.sh"',
    // A machine that restarted under a session comes back to the conversation
    // it was in, not to a blank one. The id is the one the agent's own hooks
    // last reported - see `hookScript` - and only a reopened checkout uses it.
    `if [ -f "$POLARIS_STATE_DIR/${SESSION_ENDED_FILE}" ]; then`,
    '  echo "polaris: this session has ended. Its work is kept here and the agent was not started again."',
    "  exec sh",
    "fi",
    // Every prompt as a turn of its own, without the interface: nothing is
    // typed into a terminal, and no first-run screen can stand in the way.
    'if [ -n "$POLARIS_AGENT_HEADLESS" ]; then',
    '  exec sh "$POLARIS_STATE_DIR/runner.sh"',
    "fi",
    'POLARIS_RESUME_ID=""',
    'if [ "$POLARIS_REOPENED" = "yes" ] && [ -f "$POLARIS_STATE_DIR/agent-session-id" ]; then',
    '  POLARIS_RESUME_ID="$(head -c 128 "$POLARIS_STATE_DIR/agent-session-id")"',
    "fi",
    'sh "$POLARIS_STATE_DIR/launch.sh" "$POLARIS_RESUME_ID" || true',
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
    ...AWAIT_PREINSTALL,
    ...INSTALL_ENIGMA,
    ...INSTALL_AGENT,
    ...REQUIRE_AGENT,
    ...INSTALL_GH,
    ...REPO_SETUP,
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
const SETUP_BASE64 = Buffer.from(SESSION_SETUP, "utf8").toString("base64");

/**
 * The setup written to a file before tmux is asked to run it, and tmux handed
 * only the file's name.
 *
 * tmux sends a command from its client to its server as one message, and a
 * message is capped near 16 KB. The setup grew past that (18 KB encoded) and
 * every session after it sat on "Starting" with its container restarting in a
 * loop on tmux's own `command too long`, which reached nobody. A path is a few
 * dozen bytes however long the setup gets.
 *
 * Run as `sh <file>`, which keeps the pane's terminal on all three descriptors
 * the way the `eval` this replaced did, and never as `... | sh`, whose pipe is
 * what once left the agent with no terminal to read (see above). In a temporary
 * file of its own so two sessions on one server never share it; the script is
 * fixed text and holds no secret, which all arrive in the environment.
 */
const WRITE_SETUP = [
    'POLARIS_SETUP_FILE="$(mktemp "${TMPDIR:-/tmp}/polaris-setup.XXXXXX")"',
    `echo ${SETUP_BASE64} | base64 -d > "$POLARIS_SETUP_FILE"`
];

/** tmux's argument: the file's name, expanded by the shell that calls tmux. */
export const SETUP_COMMAND = `"sh '$POLARIS_SETUP_FILE'"`;

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
    // A container that restarted keeps its /tmp, and with it the flag that said
    // the last agent was up. Left there, a prompt would be typed into the setup.
    `rm -f ${AGENT_READY_FLAG}`,
    ...INSTALL_TMUX,
    ...REQUIRE_TMUX,
    'mkdir -p "$(dirname "$POLARIS_WORKDIR")"',
    // Everything else happens in there, where it can be watched.
    ...WRITE_SETUP,
    `tmux new-session -d -s "$POLARIS_TMUX" -x "$POLARIS_COLS" -y "$POLARIS_ROWS" ${SETUP_COMMAND}`,
    // Park. See above: the container outlives the agent inside it.
    "exec tail -f /dev/null"
].join("\n");

/**
 * Where a spare container finds the session it was given. See `SPARE_BOOT`.
 *
 * In the session's own directory on the machine rather than in the container's
 * layer, so a claimed container that restarts (a reboot of its server) reads the
 * same session again instead of waiting for a claim that already happened.
 * Outside `SESSION_ROOT/polaris`, which is handed to the agent's account: this
 * holds the session's whole environment, credentials included, and stays root's.
 */
export const CLAIM_FILE = `${SESSION_ROOT}/claim.env`;

/**
 * What a spare container does: the slow part of a boot first, then wait for a
 * session.
 *
 * A spare is started while somebody is still typing (see `session-spares`), for
 * a session that does not exist yet, so it can know nothing about it: no
 * repository, no token, no credentials. What it can do is everything that does
 * not depend on those - the container itself and tmux, which is a package
 * install, then sudo, Enigma and the GitHub CLI into the account's kept home
 * (`SPARE_PREINSTALL`) - and then wait. The claim writes the session's environment to
 * `CLAIM_FILE`, and from there it is exactly the boot of `SESSION_BOOT`.
 *
 * Polling a file rather than any signal because a file is the one thing both
 * engines can hand a container (`writeFile`), and a fifth of a second is not
 * what anybody waits on here.
 */
export const SPARE_BOOT = [
    "set -eu",
    ...INSTALL_TMUX,
    ...SPARE_PREINSTALL,
    `while [ ! -s ${CLAIM_FILE} ]; do sleep 0.2; done`,
    `set -a; . ${CLAIM_FILE}; set +a`,
    ...SESSION_BOOT.split("\n").slice(1)
].join("\n");

/**
 * What makes one session on an enrolled server its own, prepended to every
 * script Polaris runs there for it.
 *
 * A container session has a machine to itself, so its tmux server, its tmux
 * session name and its `/tmp` flags are its own by construction. A server
 * session runs straight on somebody's machine, where all of those are shared:
 * the second session to boot found `polaris-agent` already taken and failed,
 * and its ready flag and setup files were the first one's. A tmux socket
 * directory and a temporary directory per session (tmux reads `TMUX_TMPDIR`,
 * and every path here goes through `TMPDIR`, read with `printenv` so the
 * boot scripts stay free of `${...}`) separate them without renaming
 * anything the steering commands address.
 *
 * Only exported where the directory exists, so a session that booted before
 * this keeps finding its tmux on the default socket. `create` is the boot's.
 */
export function hostSessionScope(sessionId: string, create = false): string {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(sessionId)) throw new Error("That is not a session id.");
    return [
        `POLARIS_SCOPE="$HOME/.polaris/sessions/${sessionId}/tmp"`,
        ...(create ? ['mkdir -p "$POLARIS_SCOPE"', 'chmod 0700 "$POLARIS_SCOPE"'] : []),
        'if [ -d "$POLARIS_SCOPE" ]; then TMUX_TMPDIR="$POLARIS_SCOPE"; TMPDIR="$POLARIS_SCOPE"; export TMUX_TMPDIR TMPDIR; fi'
    ].join("\n");
}

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
    `rm -f ${AGENT_READY_FLAG}`,
    ...REQUIRE_TMUX,
    'mkdir -p "$(dirname "$POLARIS_WORKDIR")"',
    // Same shape as the container's, and for the same reason: a terminal
    // somebody opens has to show the setup rather than nothing until it
    // finishes. Polaris installs no agent here - a server is somebody's machine
    // - so the setup inside says what is missing instead.
    ...WRITE_SETUP,
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

/**
 * The most of a capture kept, from its end. The host daemon answers a command
 * with 16 KiB at most and cuts the rest - which, for a screen read top to bottom,
 * is the newest part, the one anybody is looking for. Kept to the end here
 * instead, under that limit.
 */
export const CAPTURE_BYTES = 15 * 1024;

/** What the agent's terminal currently shows, as text. For the list, which wants
 *  a line of context per session without opening a terminal to each one. */
export function captureCommand(lines = 200, session = TMUX_SESSION): string {
    return `tmux capture-pane -p -t ${shellQuote(session)} -S -${Math.max(1, Math.floor(lines))} | tail -c ${CAPTURE_BYTES}`;
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
    return `tmux capture-pane -p -J -t ${shellQuote(session)} -S -${Math.max(1, Math.floor(lines))} | tail -c ${CAPTURE_BYTES}`;
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
