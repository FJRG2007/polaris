/**
 * Signing an agent in without sending anybody off to find a terminal.
 *
 * What this replaces was a sentence: "run `claude setup-token` wherever you are
 * already signed in to Claude Code, and paste what it prints". Every clause of
 * that is a thing Polaris was asking somebody else to do - find a machine, have
 * the tool installed on it, have it already signed in, remember a command. On a
 * deployment whose whole premise is that the person never opens a terminal, it
 * was the instruction least likely to be followed and the most likely to end in
 * somebody deciding the feature did not work.
 *
 * So Polaris supplies the machine. A throwaway container, the vendor's own login
 * command running in a tmux session inside it, and the screen it draws relayed
 * into a dialog with a line to type back into. That is the whole of the hard
 * part: an OAuth flow that wants a browser round-trip, driven from a browser.
 *
 * **The credential is read off the screen only in a shape a real login printed.**
 * A parser written against a guess silently stores the wrong line, and a wrong
 * credential looks exactly like a right one until a session fails at its login
 * prompt a week later. So only a token whose printed form was seen
 * (`screens.SCREEN_TOKENS`, Claude's since 2026-11-13) is kept on its own; any
 * other still goes through the field beneath, copied by the person.
 *
 * Nothing here has been exercised: this machine has no Docker, and the box that
 * does was unreachable. The parts that are shared with a session's runtime are
 * covered by that one's tests; the container lifecycle below is not.
 */

import * as core from "@polaris/core";
import { prisma } from "@polaris/db";
import { shellQuote } from "./session-hooks";
import * as commands from "./session-commands";
import { upWithFreshImage } from "./session-image";
import { HostdPorts } from "@/lib/deploy/ports-hostd";
import { agentSignins, signinSlug, type AgentSignin } from "./agent-signins";
import * as screens from "./signin-screen";
import * as direct from "./signin-direct";
import { configuredRequest, readCapped } from "@/lib/safe-fetch";
import * as status from "./signin-status";
import * as homes from "./home-signins";
import * as folders from "./account-folders";

/** Stamped on every container this starts, so the sweep finds them by label
 *  rather than by matching names it does not own. */
const LABEL_KEY = "polaris.agent-signin";

/** How long one may live. A login somebody walked away from is a container
 *  holding a CPU share and a tmux session forever, and there is no state in it
 *  worth keeping: the credential either reached the field or it did not. */
const MAX_LIFE_MS = 15 * 60 * 1000;

/**
 * How many one account may have running at once.
 *
 * One. This is the only place in Polaris where somebody who is not an
 * administrator causes a container to start, so the bound is the narrowest one
 * that still works: there is exactly one login happening at a time because there
 * is exactly one person doing it, and a second is a stuck first rather than a
 * second need.
 */
const PER_ACCOUNT = 1;

/** The tmux session the login command runs in, inside its own container. */
const TMUX = "polaris-signin";

/** The container, and therefore the compose project, one attempt gets. */
function containerName(id: string): string {
    return `polaris-signin-${id}`;
}

/**
 * The command that signs each credential in, and what installs the tool that
 * runs it.
 *
 * Only the ones whose login command is a documented, non-interactive-to-start
 * invocation. Anything absent falls back to the field on its own, which is
 * exactly the screen that exists today - a credential Polaris cannot walk
 * somebody through is still a credential they can paste.
 */
export interface LoginCommand {
    /** Which catalogue entry this login is of. Named rather than looked up by
     *  credential: an environment variable belongs to as many tools as declare
     *  it - ANTHROPIC_API_KEY to seven of them - so the tool is the only thing a
     *  credential's first-run answers can honestly come from. */
    readonly cli: string;
    /** The install line, when it is not the catalogue's own. */
    readonly install?: string;
    readonly command: string;
    /**
     * The vendor's own sign-out, run in the same home, for a tool whose docs
     * name one. Absent means unsupported: a logout is never inferred from the
     * login, and Polaris never deletes a tool's credential file in its place.
     */
    readonly logout?: string;
    /** Asked once, after the login, in the same container: the only way a stored
     *  credential can say whose it is. */
    readonly whoami?: string;
    /**
     * The vendor's own "am I signed in" command, run in the same home, for a
     * home login whose docs name one. Absent means none is documented, and the
     * row shows the last sign-in or sign-out Polaris ran instead.
     */
    readonly status?: string;
    /** First-run answers this login needs on top of the tool's own. */
    readonly firstRun?: readonly core.AgentFirstRunAnswer[];
    /** "device" for a login that prints an address and a code and waits for the
     *  browser, so the dialog shows those two and keeps the terminal folded;
     *  "paste" for one that asks for something typed back into it. */
    readonly flow: SigninFlow;
    /** Questions on the screen Polaris answers itself, once each. */
    readonly autoAnswers?: readonly screens.SigninAutoAnswer[];
    /**
     * The login stays in the person's home and nothing is stored.
     *
     * For a tool whose login is documented but whose credential location is
     * not: the container mounts the same persistent home a session does, so the
     * login it leaves there is the sessions' login. There is no row, no capture
     * and nothing to paste - the key is Polaris's own name for the sign-in.
     */
    readonly home?: true;
    /**
     * A command typed into the tool once it is ready, for a tool whose login is
     * a command inside its own interface (`/login`) rather than a subcommand.
     * Typed on its own once one of `after` is on the screen; with no marker
     * known, the dialog offers it as a button instead of guessing when.
     */
    readonly input?: { readonly text: string; readonly after?: readonly string[] };
    /**
     * A home login the tool can hold only one of: its vendor documents no
     * variable, credential file or key that would let a second account sit
     * beside the first, so signing in again replaces it. The reason for each is
     * in docs/agent-catalogue.md ("More than one account").
     */
    readonly single?: true;
}

/** "device" prints an address and a code; "paste" asks for something typed
 *  back; "open" only prints an address to open and waits for the browser. */
export type SigninFlow = "device" | "paste" | "open";

export const LOGIN_COMMANDS: Readonly<Record<string, LoginCommand>> = {
    CLAUDE_CODE_OAUTH_TOKEN: {
        cli: "claude",
        // --allow-scripts and all: npm now declines a package's postinstall
        // unless it is named, and this one's postinstall is what puts the binary
        // on the PATH.
        install:
            "npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code",
        command: "claude setup-token",
        whoami: "claude auth status --json",
        flow: "paste"
    },
    // `codex login --device-auth` prints a URL and a one-time code and waits for
    // the browser (developers.openai.com/codex/auth). The store is pinned to the
    // file because that file is the thing captured: a keyring login would leave
    // nothing in the home to keep.
    CODEX_CHATGPT_AUTH: {
        cli: "codex",
        command: "codex -c 'cli_auth_credentials_store=\"file\"' login --device-auth",
        // "run `codex logout` to clear the current credentials" (same page),
        // against the same file store the login was pinned to.
        logout: "codex -c 'cli_auth_credentials_store=\"file\"' logout",
        flow: "device"
    },
    // Gemini CLI has no login subcommand. Started with Google sign-in selected
    // and NO_BROWSER set, it prints the consent URL and reads the authorization
    // code from the terminal (packages/core/src/code_assist/oauth2.ts), then
    // caches it in ~/.gemini/oauth_creds.json. The selection is asserted because
    // the person is choosing Google sign-in right now, and without it an
    // interactive start opens a picker instead of the login.
    GEMINI_GOOGLE_AUTH: {
        cli: "gemini",
        command: "NO_BROWSER=true gemini",
        flow: "paste",
        firstRun: [
            {
                file: ".gemini/settings.json",
                assert: { security: { auth: { selectedType: "oauth-personal" } } }
            }
        ]
    },
    // `copilot login --device-code`, from GitHub's authenticate-copilot-cli
    // page. With no system keychain, which this container has none of, it asks
    // to keep the token in ~/.copilot/config.json. That file is exactly what is
    // captured, so the answer is always yes and Polaris gives it: there is no
    // documented flag that skips the question.
    COPILOT_DEVICE_AUTH: {
        cli: "copilot",
        command: "copilot login --device-code",
        flow: "device",
        autoAnswers: [{ prompt: "Store token in plaintext config file? (y/N)", reply: "y" }]
    },
    // `auggie auth login`, with `--headless` "on machines without a browser",
    // and `auggie auth logout` to remove the local token - both from
    // docs.augmentcode.com/cli/setup-auggie/authentication. What the headless
    // flow draws was never seen, so the terminal stays open for whatever it
    // asks; the session file it writes is what is captured.
    AUGGIE_ACCOUNT_AUTH: {
        cli: "auggie",
        command: "auggie auth login --headless",
        logout: "auggie auth logout",
        flow: "paste"
    },
    // The same login as DEVIN_HOME_LOGIN below, kept as a stored account: the
    // token lands in ~/.local/share/devin/credentials.toml
    // (docs.devin.ai/cli/enterprise/devin-auth), which is captured, so each
    // account is a row of its own, as Auggie's are.
    DEVIN_ACCOUNT_AUTH: {
        cli: "devin",
        command: "devin auth login --force-manual-token-flow",
        logout: "devin auth logout",
        flow: "paste"
    },

    // Logins kept in the home (`home: true`): documented commands whose
    // credential location the vendor does not name. Each source is in
    // docs/agent-catalogue.md ("Sign-in commands").

    // cursor.com/docs/cli/reference/authentication: `login` with
    // NO_OPEN_BROWSER=1 prints the address instead of opening a browser, and
    // `logout` clears it. Run as the catalogue's binary, which the CLI installs.
    CURSOR_HOME_LOGIN: {
        cli: "cursor",
        command: "NO_OPEN_BROWSER=1 cursor-agent login",
        logout: "cursor-agent logout",
        // Same page: `status` shows "whether you're authenticated".
        status: "cursor-agent status",
        flow: "open",
        home: true
    },
    // kiro.dev/docs/getting-started/authentication: `kiro-cli login`, a sign-in
    // method chosen on the screen, device flow in remote environments. No CLI
    // logout is documented. "To check which authentication method is active,
    // run `kiro-cli whoami`" (same page).
    KIRO_HOME_LOGIN: {
        cli: "kiro",
        command: "kiro-cli login",
        status: "kiro-cli whoami",
        flow: "paste",
        home: true
    },
    // docs.x.ai/build/cli/reference: `grok login --device-auth` for headless or
    // remote environments, `grok logout` to clear the cached credentials.
    GROK_HOME_LOGIN: {
        cli: "grok",
        command: "grok login --device-auth",
        logout: "grok logout",
        flow: "device",
        home: true
    },
    // docs.devin.ai/cli/reference/commands: `--force-manual-token-flow` skips
    // the browser and takes a pasted token; `devin auth logout` removes it.
    DEVIN_HOME_LOGIN: {
        cli: "devin",
        command: "devin auth login --force-manual-token-flow",
        logout: "devin auth logout",
        // Same page: `devin auth status`, "Check authentication status".
        status: "devin auth status",
        flow: "paste",
        home: true
    },
    // ampcode.com/docs/cli: `amp login` adds an account, `amp logout` removes
    // the active one. Whether it finishes without a local browser is not said,
    // so the terminal stays open for whatever it asks.
    AMP_HOME_LOGIN: { cli: "amp", command: "amp login", logout: "amp logout", flow: "paste", home: true },
    // docs.autohand.ai/working-with-autohand-code/cli-reference.
    AUTOHAND_HOME_LOGIN: {
        cli: "autohand",
        command: "autohand login",
        logout: "autohand logout",
        flow: "paste",
        home: true
    },
    // The same login, run with AUTOHAND_HOME pointed at a folder of the
    // account's own (`account-folders.ts`), so each account is a row. No
    // logout: removing the row clears the folder, which is the sign-out.
    AUTOHAND_ACCOUNT_HOME: { cli: "autohand", command: "autohand login", flow: "paste" },
    // fx.sh/docs/getting-started/authentication: without a provider name,
    // `fx login` signs in to Vercel and `fx logout` signs out of it.
    FX_HOME_LOGIN: { cli: "fx", command: "fx login", logout: "fx logout", flow: "paste", home: true },
    // mimo.mi.com/docs/en-US/tokenplan/integration/mimo-code: `mimo auth login`,
    // then MiMo chosen on the screen. No logout is documented.
    MIMO_HOME_LOGIN: { cli: "mimo-code", command: "mimo auth login", flow: "paste", home: true, single: true },
    // code.minimax.io/docs/cli/quick-start: `mcode login --region global` for a
    // Global account (the bare command is the Mainland China one), and
    // `mcode logout`.
    MINIMAX_HOME_LOGIN: {
        cli: "minimax-code",
        command: "mcode login --region global",
        logout: "mcode logout",
        flow: "paste",
        home: true,
        single: true
    },

    // Logins typed into the tool itself once it is ready. The ready markers are
    // Agent Orchestrator's, as observed on each tool's first screen.
    // Ported from Agent Orchestrator (github.com/aoagents/agent-orchestrator,
    // backend/internal/service/agentauth/plans.go), Apache-2.0.

    // moonshotai.github.io/kimi-code/en/guides/getting-started: "enter `/login`
    // to begin the login flow", whose Kimi Code option is a device-code flow.
    KIMI_HOME_LOGIN: {
        cli: "kimi",
        command: "kimi",
        flow: "paste",
        home: true,
        input: { text: "/login", after: ["Run /login or /provider to get started."] }
    },
    // The same login, run with KIMI_CODE_HOME pointed at a folder of the
    // account's own (`account-folders.ts`), so each account is a row.
    KIMI_ACCOUNT_HOME: {
        cli: "kimi",
        command: "kimi",
        flow: "paste",
        input: { text: "/login", after: ["Run /login or /provider to get started."] }
    },
    // github.com/earendil-works/pi README: "run `/login` inside Pi to connect a
    // subscription or API key".
    PI_HOME_LOGIN: {
        cli: "pi",
        command: "pi",
        flow: "paste",
        home: true,
        input: { text: "/login", after: ["0.0%/", "Pi can explain its own features"] }
    },
    // The same login, run with PI_CODING_AGENT_DIR pointed at a folder of the
    // account's own (`account-folders.ts`), so each account is a row.
    PI_ACCOUNT_HOME: {
        cli: "pi",
        command: "pi",
        flow: "paste",
        input: { text: "/login", after: ["0.0%/", "Pi can explain its own features"] }
    },
    // docs.factory.com/cli/configuration/cli-reference: `/login` signs in to
    // Factory. No ready marker is known, so the dialog offers it as a button.
    DROID_HOME_LOGIN: { cli: "droid", command: "droid", flow: "paste", home: true, input: { text: "/login" } }
};

/** What an attempt runs: the vendor's login, or its documented sign-out. */
export type SigninMode = "login" | "logout";

/** The command an attempt of this mode runs, or null when the vendor documents
 *  none - which for a logout is most of them. */
export function signinCommand(env: string, mode: SigninMode): string | null {
    const login = LOGIN_COMMANDS[env];
    if (!login) return null;
    return mode === "login" ? login.command : (login.logout ?? null);
}

/** Whether Polaris can sign this one out of the home for somebody. */
export function canSignout(env: string): boolean {
    return signinCommand(env, "logout") !== null;
}

function cliOf(env: string): core.AgentCli | undefined {
    return core.AGENT_CLIS.find((one) => one.id === LOGIN_COMMANDS[env]?.cli);
}

/** The install line a login runs: its own, or the catalogue's. */
export function signinInstall(env: string): string {
    return LOGIN_COMMANDS[env]?.install ?? cliOf(env)?.install ?? "";
}

/**
 * The file a login leaves its credential in, relative to the home, or null for
 * one that prints a token to copy instead.
 */
export function signinCredentialFile(env: string): string | null {
    return cliOf(env)?.credentials.find((one) => one.env === env)?.file ?? null;
}

/**
 * The first-run answers for the tool this login runs.
 *
 * Resolved through the catalogue rather than listed again here: the entry above
 * names the tool, and that tool's entry is where what its first run asks was
 * written down. Empty for a tool the catalogue does not hold, which is the same
 * "nothing sourced" answer as everywhere else.
 */
export function signinFirstRun(env: string, folderId?: string): readonly core.AgentFirstRunAnswer[] {
    const answers = [...(cliOf(env)?.firstRun ?? []), ...(LOGIN_COMMANDS[env]?.firstRun ?? [])];
    // A login kept in an account folder reads its configuration from there.
    const folder = folderId ? folders.folderLoginFor(env) : null;
    return folder && folderId ? folders.folderFirstRun(answers, folder.credential, folder.cli.id, folderId) : answers;
}

function firstRunFor(env: string, folderId?: string): string {
    return Buffer.from(commands.firstRunScript(signinFirstRun(env, folderId)), "utf8").toString("base64");
}

/**
 * The variables a login kept in an account folder runs with: the tool's own
 * pointed at the folder, and the same path for the boot to create. Empty for
 * every other login. The folder is the attempt's row id, so the stored row
 * that comes out of it names the folder its login landed in.
 */
export function signinFolderEnv(env: string, attemptId: string): Record<string, string> {
    const folder = folders.folderLoginFor(env);
    if (!folder) return {};
    const path = folders.accountFolder(commands.AGENT_HOME, folder.cli.id, attemptId);
    return { [folder.credential.dir.env]: path, POLARIS_ACCOUNT_DIR: path };
}

/** Whether Polaris can run this one's login for somebody, or only take a paste. */
export function canAssistSignin(env: string): boolean {
    return env in LOGIN_COMMANDS;
}

/** Whether this sign-in leaves its login in the home and stores nothing. */
export function isHomeSignin(env: string): boolean {
    return LOGIN_COMMANDS[env]?.home === true;
}

/**
 * The sign-ins that store nothing, shaped like the ones that do so one dialog
 * runs both. Never in `agentSignins()`: that list is what may be stored, and
 * these have no row to store.
 */
export function homeSignins(): AgentSignin[] {
    return Object.entries(LOGIN_COMMANDS).flatMap(([env, login]) => {
        const cli = login.home ? core.agentCliById(login.cli) : null;
        if (!cli) return [];
        return [
            {
                env,
                slug: signinSlug(env),
                label: cli.label,
                url: cli.docs,
                howto: null,
                subscription: true,
                file: null,
                onScreen: false,
                serves: [{ id: cli.id, label: cli.label }],
                home: true,
                signout: canSignout(env),
                single: login.single === true
            }
        ];
    });
}

/** The sign-ins Polaris can walk somebody through, for a screen that offers it. */
export function assistedSignins(): AgentSignin[] {
    return [
        ...agentSignins()
            .filter((signin) => canAssistSignin(signin.env) && !isHomeSignin(signin.env))
            .map((signin) => ({ ...signin, signout: canSignout(signin.env) })),
        ...homeSignins()
    ];
}

/**
 * What the container does when it starts.
 *
 * Fixed, exactly as a session's is: nothing from an account, a credential or an
 * operator's settings is interpolated into a shell here, and the one value it
 * needs arrives in the environment. It parks rather than exiting so the tmux
 * session outlives the command - a login that finished still has its result on
 * the screen, which is the entire point.
 */
export const SIGNIN_BOOT = [
    "set -eu",
    "if ! command -v tmux >/dev/null 2>&1; then",
    "  apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq tmux >/dev/null 2>&1 || true",
    "fi",
    'command -v tmux >/dev/null 2>&1 || { echo "polaris: this machine has no tmux and one could not be installed"; exit 1; }',
    // The same account and the same home a session gets, from the same builder.
    // This is what makes the dialog worth opening at all: what the login writes
    // lands in the home the sessions read, so it is not a string to copy back -
    // it is the machine being signed in. The paste is still offered, because a
    // token is also useful somewhere this home does not reach, but it stopped
    // being the only thing this produces.
    commands.AGENT_ACCOUNT_SETUP,
    // A login kept in an account folder (`account-folders.ts`) gets that
    // folder made first, as the agent and private to it.
    'if [ -n "$POLARIS_ACCOUNT_DIR" ]; then',
    `  as_agent 'umask 077; mkdir -p "$POLARIS_ACCOUNT_DIR"' || true`,
    "fi",
    // Into that home's npm prefix, so a tool installed here is one the next
    // session finds already installed.
    'as_agent "$POLARIS_INSTALL" >/dev/null 2>&1 || true',
    // And the tool's first-run wizard, answered here as well as in a session -
    // because the home is the same one, and whichever of the two reaches it
    // first is the one that has to prepare it. A dialog four lines tall is a
    // worse place to meet a full-screen "choose your colour scheme" than a
    // session's terminal is.
    'if [ -n "$POLARIS_FIRST_RUN" ]; then',
    '  printf %s "$POLARIS_FIRST_RUN" | base64 -d > /tmp/polaris-first-run.sh',
    "  chmod 0755 /tmp/polaris-first-run.sh",
    '  as_agent "sh /tmp/polaris-first-run.sh" >/dev/null 2>&1 || true',
    "  rm -f /tmp/polaris-first-run.sh",
    "fi",
    // Through a file rather than nested quoting: the login is a value from the
    // catalogue, and `su -p node -c "<it>"` inside a tmux argument is three
    // levels of quoting to get wrong once.
    "printf '%s' \"$POLARIS_LOGIN\" > /tmp/polaris-login.sh",
    "chmod 0755 /tmp/polaris-login.sh",
    "POLARIS_RUN='sh /tmp/polaris-login.sh'",
    'if [ "$POLARIS_AS_ROOT" = "yes" ]; then',
    "  POLARIS_RUN=\"su -p $POLARIS_RUNAS -c 'sh /tmp/polaris-login.sh'\"",
    "fi",
    // Then the exit status on a line of its own, and a process that holds the
    // pane open printing nothing - so the screen survives the command with its
    // last words still on it. It used to be `exec sh`, which in a pane with no
    // job control printed "can't access tty" and a bare prompt under the result.
    // The status line is read by the dialog and never shown.
    'POLARIS_RUN="$POLARIS_RUN; polaris_status=\\$?; echo; echo polaris-signin-exit \\$polaris_status; exec tail -f /dev/null"',
    'tmux new-session -d -s "$POLARIS_TMUX" -x "$POLARIS_COLS" -y "$POLARIS_ROWS" "$POLARIS_RUN"',
    // Only now is there a screen to read. Before this a capture is tmux not
    // being installed yet or having no session yet, and its complaints about
    // that are what reached the dialog in place of the login.
    ": > /tmp/polaris-signin-ready",
    "exec tail -f /dev/null"
].join("\n");

/** One attempt in flight. */
export interface SigninAttempt {
    readonly id: string;
    readonly env: string;
}

/** Which rung of the ladder an attempt is on: the vendor's endpoints called
 *  from here, or the vendor's CLI in a container. Pasting by hand is the rung
 *  under both, and is the dialog's own field. */
export type SigninRung = "direct" | "cli";

/** A direct sign-in in flight. Server memory only: what is in it - the device
 *  code's id, and the credential once issued - never reaches a browser except
 *  as the stored, encrypted credential. Gone with the attempt. */
interface DirectAttempt {
    readonly userId: string;
    readonly device: direct.DeviceAuthorization;
    nextPollAt: number;
    polling: boolean;
    value: string | null;
    email: string | null;
}
const directAttempts = new Map<string, DirectAttempt>();

/** Attempts whose direct rung failed, so the screen can say it fell back, and
 *  the container start still in flight for each. */
const fellBack = new Set<string>();
/** Attempts running a sign-out rather than a login. Never captured from: what
 *  is left in the home after a logout is not a credential to keep. */
const signingOut = new Set<string>();
const starting = new Map<string, Promise<void>>();

/** Every request the direct rung makes: the guarded fetch, public addresses
 *  only, no redirects, a timeout, and a capped read. Nothing it sends or
 *  receives is logged. */
const DIRECT_TIMEOUT_MS = 15_000;
const DIRECT_MAX_BYTES = 64 * 1024;
const guardedPost: direct.DirectPost = async (url, body) => {
    const init =
        "json" in body
            ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body.json) }
            : {
                  headers: { "content-type": "application/x-www-form-urlencoded" },
                  body: new URLSearchParams(body.form).toString()
              };
    const response = await configuredRequest(
        url,
        { method: "POST", ...init, timeoutMs: DIRECT_TIMEOUT_MS },
        { allowPrivate: false }
    );
    const bytes = await readCapped(response as unknown as Parameters<typeof readCapped>[0], DIRECT_MAX_BYTES);
    let json: unknown = null;
    try {
        json = bytes ? JSON.parse(Buffer.from(bytes).toString("utf8")) : null;
    } catch {
        json = null;
    }
    return { status: response.status, json };
};

/** Why a direct rung was given up, for the server log: a status line or an
 *  error's class, never a body or a token. */
function failureName(error: unknown): string {
    if (error instanceof direct.DirectSigninError) return error.message;
    return error instanceof Error ? error.name : "unknown";
}

/**
 * Start one.
 *
 * Returns as soon as the machine has a container, not when the command is ready
 * - installing the tool is a minute of somebody else's network, and the screen
 * shows that happening rather than holding a click open through it.
 */
export async function beginSignin(
    userId: string,
    env: string,
    mode: SigninMode = "login"
): Promise<SigninAttempt> {
    const command = signinCommand(env, mode);
    if (command === null) throw new Error("Polaris cannot run that sign-in for you.");

    await sweepExpired();
    const running = await prisma.agentSigninAttempt.count({ where: { userId, endedAt: null } });
    if (running >= PER_ACCOUNT) {
        throw new Error("A sign-in is already open. Finish or cancel that one first.");
    }

    const attempt = await prisma.agentSigninAttempt.create({
        data: { userId, env },
        select: { id: true, env: true }
    });

    // A sign-out has no direct rung and nothing to capture: it runs the
    // vendor's command against the home and ends with that home signed out.
    if (mode === "logout") {
        signingOut.add(attempt.id);
        await startContainer(userId, attempt, command);
        return attempt;
    }

    // The comfortable rung first: a code in a second, no machine to start.
    if (direct.hasDirectSignin(env)) {
        try {
            const device = await direct.requestDeviceAuthorization(guardedPost, Date.now());
            directAttempts.set(attempt.id, {
                userId,
                device,
                nextPollAt: Date.now() + device.intervalMs,
                polling: false,
                value: null,
                email: null
            });
            return attempt;
        } catch (error) {
            console.warn("[agent-signin] direct sign-in unavailable, running the CLI:", failureName(error));
            fellBack.add(attempt.id);
        }
    }
    await startContainer(userId, attempt, command);
    return attempt;
}

/** The CLI rung: the vendor's own login in a container. Ends the attempt if the
 *  container cannot be started, since an attempt nobody can reach still counts
 *  against the per-account bound. */
async function startContainer(userId: string, attempt: SigninAttempt, command: string): Promise<void> {
    try {
        const name = containerName(attempt.id);
        await upWithFreshImage((pullPolicy) =>
            new HostdPorts().composeUp({
                project: name,
                services: [
                    {
                        name,
                        image: commands.SESSION_IMAGE,
                        pullPolicy,
                        env: {
                            POLARIS_TMUX: TMUX,
                            POLARIS_COLS: String(commands.SIGNIN_COLS),
                            POLARIS_ROWS: String(commands.SIGNIN_ROWS),
                            POLARIS_INSTALL: signinInstall(attempt.env),
                            POLARIS_FIRST_RUN: firstRunFor(attempt.env, attempt.id),
                            POLARIS_LOGIN: command,
                            POLARIS_RUNAS: commands.CONTAINER_USER,
                            POLARIS_HOME: commands.AGENT_HOME,
                            // Empty unless the login is kept in an account folder.
                            POLARIS_ACCOUNT_DIR: "",
                            ...signinFolderEnv(attempt.env, attempt.id)
                        },
                        ports: [],
                        // This person's own home, the one their sessions run in.
                        // Nothing else is mounted and no credential is carried in:
                        // what the login writes is the only thing that leaves here,
                        // and it leaves by already being in the home.
                        volumes: [
                            {
                                source: commands.agentHomeSource(userId),
                                target: commands.AGENT_HOME,
                                kind: "bind" as const
                            }
                        ],
                        labels: { [LABEL_KEY]: attempt.id },
                        command: commands.bootArgv(SIGNIN_BOOT),
                        networks: [],
                        // Never restarted. A login that died is a login to start
                        // again, not one to resume half way through an OAuth round
                        // trip that has since expired.
                        restart: "no"
                    }
                ],
                volumes: [],
                networks: []
            }),
            () => new HostdPorts().pull(commands.SESSION_IMAGE)
        );
    } catch (error) {
        // The row exists and the container does not, so the row goes: an attempt
        // nobody can reach still counts against the bound above.
        await prisma.agentSigninAttempt
            .update({ where: { id: attempt.id }, data: { endedAt: new Date() } })
            .catch(() => undefined);
        throw error;
    }
}

/** Run one command in an attempt's container, or throw if it is not this
 *  person's or is over. */
async function runIn(userId: string, id: string, command: string): Promise<string> {
    const attempt = await prisma.agentSigninAttempt.findFirst({
        where: { id, userId, endedAt: null },
        select: { id: true }
    });
    if (!attempt) throw new Error("That sign-in is no longer open.");
    const result = await new HostdPorts().runIn(containerName(id), commands.shellArgv(command));
    return result.output;
}

/**
 * What the login command's terminal currently shows, and the address on it.
 *
 * Joined rather than raw, which is what makes the address findable at all: a
 * terminal breaks a line at its own width, and one of these URLs is three
 * hundred characters, so unjoined it arrives in pieces with the break in the
 * middle of a query parameter.
 *
 * `ready` is what the dialog waits on. A container spends its first minute
 * installing a package manager's worth of tool, during which the terminal has
 * nothing on it at all - and a blank box with no explanation is the part of this
 * that read as broken.
 */
export interface SigninView extends screens.SigninProgress {
    readonly ready: boolean;
    readonly flow: SigninFlow;
    readonly rung: SigninRung;
    /** The direct rung failed and this is the CLI standing in for it. */
    readonly fellBack: boolean;
    /** The command this login types into its tool, while it is still to be
     *  typed: the dialog offers it as a button, for a tool with no known ready
     *  marker and for one whose marker never showed. */
    readonly input?: string | null;
}

/**
 * The capture, and nothing at all until the boot says the session exists.
 *
 * tmux's own errors go nowhere: a poll that lands while it is still being
 * installed answers with an empty screen, which the dialog shows as the machine
 * still getting ready rather than as "tmux: not found" in the terminal.
 */
export function signinCaptureCommand(): string {
    return `[ -f ${screens.SIGNIN_READY_FILE} ] || exit 0; { ${commands.captureJoinedCommand(60, TMUX)}; } 2>/dev/null`;
}

/** Attempts whose prompt has been answered, by prompt, so each is answered once
 *  even when two polls read the same screen. Cleared when the attempt ends. */
const answered = new Map<string, Set<string>>();
/** Attempts whose in-tool login command was typed, by Polaris or from the
 *  dialog's button. Cleared when the attempt ends. */
const typed = new Set<string>();

/**
 * Type a login's in-tool command once, from the dialog's button.
 *
 * The text is the catalogue's, never the browser's: the button only says when.
 */
export async function typeSigninInput(userId: string, id: string): Promise<void> {
    const attempt = await prisma.agentSigninAttempt.findFirst({
        where: { id, userId, endedAt: null },
        select: { env: true }
    });
    const input = attempt ? LOGIN_COMMANDS[attempt.env]?.input : undefined;
    if (!input || typed.has(id) || signingOut.has(id)) return;
    typed.add(id);
    await answerSignin(userId, id, input.text);
}

export async function signinScreen(userId: string, id: string): Promise<SigninView> {
    const attempt = await prisma.agentSigninAttempt.findFirst({
        where: { id, userId, endedAt: null },
        select: { env: true }
    });
    if (!attempt) throw new Error("That sign-in is no longer open.");
    const login = LOGIN_COMMANDS[attempt.env];

    const pending = directAttempts.get(id);
    if (pending) {
        const view = await directView(id, attempt.env, pending);
        if (view.finished && view.exitCode === 0) recordOutcome(userId, attempt.env, "login");
        return view;
    }
    if (starting.has(id)) {
        // Fell back a moment ago and the machine is still coming up.
        return {
            ...screens.readSigninScreen(""),
            ready: false,
            flow: login?.flow ?? "paste",
            rung: "cli",
            fellBack: true
        };
    }

    const read = screens.readSigninScreen(await runIn(userId, id, signinCaptureCommand()));
    // A login that prints its token has finished once the whole token is on the
    // screen, whether or not the command has returned yet.
    const progress =
        !read.finished && screens.screenTokenIn(attempt.env, read.screen) !== null
            ? { ...read, finished: true }
            : read;

    const answers = login?.autoAnswers ?? [];
    const reply = screens.pendingAutoAnswer(progress.screen, answers);
    const prompt = answers.find((one) => one.reply === reply)?.prompt;
    const done = answered.get(id) ?? new Set<string>();
    if (reply !== null && prompt && !done.has(prompt)) {
        done.add(prompt);
        answered.set(id, done);
        await answerSignin(userId, id, reply).catch(() => undefined);
    }

    // A login typed into the tool: typed once, as soon as the tool says it is
    // ready. A sign-out never types it.
    const input = login?.input && !signingOut.has(id) && !typed.has(id) ? login.input : null;
    if (input && screens.screenShowsAny(progress.screen, input.after ?? [])) {
        typed.add(id);
        await answerSignin(userId, id, input.text).catch(() => undefined);
    }

    if (progress.finished && progress.exitCode === 0) {
        recordOutcome(userId, attempt.env, signingOut.has(id) ? "logout" : "login");
    }

    return {
        ...progress,
        ready: progress.screen.trim().length > 0,
        flow: login?.flow ?? "paste",
        rung: "cli",
        fellBack: fellBack.has(id),
        input: input && !typed.has(id) ? input.text : null
    };
}

/**
 * One read of a direct attempt: the address and code it already has, and - no
 * more often than the vendor's interval - one poll of whether it was approved.
 * Any failure but "not yet" falls back to the CLI on the same attempt.
 */
async function directView(id: string, env: string, pending: DirectAttempt): Promise<SigninView> {
    const now = Date.now();
    const view = (finished: boolean, exitCode: number | null): SigninView => ({
        screen: "",
        url: pending.device.verificationUrl,
        code: pending.device.userCode,
        signedInAs: finished ? pending.email : null,
        exitCode,
        finished,
        ready: true,
        flow: "device",
        rung: "direct",
        fellBack: false
    });
    if (pending.value) return view(true, 0);
    // Expired unapproved: the person walked away, which a fallback would not
    // help. The dialog offers to start again.
    if (now >= pending.device.expiresAt) return view(false, 1);
    if (pending.polling || now < pending.nextPollAt) return view(false, null);

    pending.polling = true;
    try {
        const grant = await direct.pollDeviceGrant(guardedPost, pending.device);
        if (grant) {
            const tokens = await direct.exchangeGrant(guardedPost, grant);
            pending.value = direct.codexAuthFile(tokens, new Date());
            pending.email = direct.tokenIdentity(tokens).email;
            return view(true, 0);
        }
        pending.nextPollAt = Date.now() + pending.device.intervalMs;
        return view(false, null);
    } catch (error) {
        console.warn("[agent-signin] direct sign-in failed, running the CLI:", failureName(error));
        directAttempts.delete(id);
        fellBack.add(id);
        const login = LOGIN_COMMANDS[env];
        if (login) {
            starting.set(
                id,
                startContainer(pending.userId, { id, env }, login.command)
                    .catch(() => undefined)
                    .finally(() => starting.delete(id))
            );
        }
        return {
            ...screens.readSigninScreen(""),
            ready: false,
            flow: "device",
            rung: "cli",
            fellBack: true
        };
    } finally {
        pending.polling = false;
    }
}

/**
 * Type a line into it.
 *
 * The same paste-then-submit the sessions use, and for the same reason: the text
 * is a code somebody copied out of a browser, it goes in through tmux's paste
 * buffer so a newline in the middle of it is text rather than Enter, and the
 * submit is a separate call after the paste has landed.
 */
export async function answerSignin(userId: string, id: string, text: string): Promise<void> {
    // A direct attempt has no terminal to type into.
    if (directAttempts.get(id)?.userId === userId) return;
    await runIn(userId, id, commands.pastePromptCommand(text, TMUX));
    await new Promise((resolve) => setTimeout(resolve, commands.submitDelayMs(text)));
    await runIn(userId, id, commands.submitCommand(TMUX));
}

/**
 * Take the container away.
 *
 * Called when the credential has been copied out, when somebody gives up, and by
 * the sweep. Idempotent, and it never reports a failure to remove: the row is
 * closed either way, because a row left open would block the next attempt over a
 * container that is already gone.
 */
export async function endSignin(userId: string, id: string): Promise<void> {
    answered.delete(id);
    typed.delete(id);
    if (directAttempts.get(id)?.userId === userId) directAttempts.delete(id);
    fellBack.delete(id);
    signingOut.delete(id);
    await prisma.agentSigninAttempt
        .updateMany({ where: { id, userId, endedAt: null }, data: { endedAt: new Date() } })
        .catch(() => undefined);
    await new HostdPorts().composeDown(containerName(id)).catch(() => undefined);
}

/**
 * Containers from attempts nobody finished.
 *
 * A login is abandoned far more often than it is completed - somebody opens it,
 * reads what it wants, and goes to find the other browser - so this is the
 * normal ending rather than the exceptional one.
 */
export async function sweepExpired(): Promise<number> {
    const cutoff = new Date(Date.now() - MAX_LIFE_MS);
    const stale = await prisma.agentSigninAttempt.findMany({
        where: { endedAt: null, startedAt: { lt: cutoff } },
        select: { id: true }
    });
    for (const attempt of stale) {
        directAttempts.delete(attempt.id);
        fellBack.delete(attempt.id);
        signingOut.delete(attempt.id);
        answered.delete(attempt.id);
        typed.delete(attempt.id);
        await prisma.agentSigninAttempt
            .update({ where: { id: attempt.id }, data: { endedAt: new Date() } })
            .catch(() => undefined);
        await new HostdPorts().composeDown(containerName(attempt.id)).catch(() => undefined);
    }
    return stale.length;
}

// ---------------------------------------------------------------------------
// Whose account it turned out to be
// ---------------------------------------------------------------------------

/**
 * What a credential says about itself.
 *
 * Every field is optional and the whole thing is optional, because the answer
 * comes from asking somebody else's program a question it was not obliged to
 * answer. A credential with no identity is still a working credential; it is
 * just one whose row has to be told apart by the name its owner gave it.
 *
 * Deliberately no spend or plan figure. Neither is in anything Polaris can ask
 * for here, and a number invented for a screen is worse than an empty space -
 * it reads as fact and nobody re-checks it. What the row can honestly show is
 * when it was last used, which the store already records.
 */
export interface SigninIdentity {
    readonly email?: string;
    readonly organization?: string;
}

/**
 * Read the identity out of what the tool's own status command printed.
 *
 * Pure, so the shapes can be asserted without a container. Vendors disagree
 * about where they put an address even between their own versions, so several
 * keys are tried and the first that holds a string wins - and nothing is
 * inferred from anything that is not one of them.
 */
export function parseSigninIdentity(output: string): SigninIdentity {
    let parsed: unknown;
    try {
        parsed = JSON.parse(output.trim());
    } catch {
        // Not JSON, which is what a version without the flag prints. No identity
        // is a fine answer; a guess pulled out of prose is not.
        return {};
    }
    if (!parsed || typeof parsed !== "object") return {};
    const record = parsed as Record<string, unknown>;
    const account =
        record.account && typeof record.account === "object"
            ? (record.account as Record<string, unknown>)
            : {};

    const read = (...keys: string[]): string | undefined => {
        for (const key of keys) {
            const value = record[key] ?? account[key];
            if (typeof value === "string" && value.trim()) return value.trim();
        }
        return undefined;
    };

    const identity: SigninIdentity = {};
    const email = read("email", "emailAddress");
    if (email) Object.assign(identity, { email });
    const organization = read("organizationName", "organization");
    if (organization) Object.assign(identity, { organization });
    return identity;
}

/**
 * The status command, run by whoever did the login.
 *
 * `docker exec` enters the container as root with root's PATH and root's home,
 * and neither of those is where any of this is: the tool was installed into the
 * agent's own npm prefix and the credential was written into the agent's own
 * home. Asked as root it is a command that does not exist, whose output is not
 * JSON, which is an identity silently lost on every credential this stores.
 *
 * So the same preamble the boot used, then `as_agent` - one definition of who
 * the agent is and where its home is, rather than a second copy here that can
 * drift from it. Its own output is thrown away, and that is not tidiness: what
 * comes back is parsed as JSON and nothing else, so one line of setup chatter
 * ahead of it is the identity lost just as surely as no answer at all. The
 * assignments and the `as_agent` it defines outlive the group; only what it
 * printed does not.
 */
export function whoamiScript(command: string): string {
    return [
        "{",
        commands.AGENT_ACCOUNT_SETUP,
        "} >/dev/null 2>&1",
        `as_agent ${shellQuote(command)}`
    ].join("\n");
}

/**
 * Ask the container who just signed in.
 *
 * Best effort by design: it runs after the credential is already in somebody's
 * hand, so a tool that will not answer costs a label on a row rather than the
 * login. Returns an empty identity for every failure there is - no command for
 * this credential, a container already gone, a version that prints prose.
 */
export async function identifySignin(
    userId: string,
    id: string,
    env: string
): Promise<SigninIdentity> {
    const pending = directAttempts.get(id);
    if (pending) return pending.userId === userId && pending.email ? { email: pending.email } : {};
    const command = LOGIN_COMMANDS[env]?.whoami;
    if (!command) return {};
    try {
        return parseSigninIdentity(await runIn(userId, id, whoamiScript(command)));
    } catch {
        return {};
    }
}

// ---------------------------------------------------------------------------
// A login that leaves a file rather than a line to copy
// ---------------------------------------------------------------------------

/** The largest credential file kept. These are a few kilobytes of JSON; the
 *  bound keeps a runaway file from becoming a row, and it sits well under the
 *  sixteen kilobytes a command's output is cut at. */
export const CREDENTIAL_FILE_MAX = 8192;

/**
 * Print a credential file as one line of base64, as the agent, or nothing.
 *
 * The path is a catalogue value, never anything typed, and it is quoted all the
 * same. As the agent, so a file only the agent can read is still read; the
 * home is the one the attempt mounted.
 */
export function credentialFileScript(file: string): string {
    return whoamiScript(`f="$POLARIS_HOME"/${shellQuote(file)}; [ -s "$f" ] && base64 -w0 "$f" || true`);
}

/**
 * What a capture read, checked before anything is kept.
 *
 * Pure. The value stored is the file's base64, the same shape the session boot
 * decodes back into the home. It has to decode to a whole file no larger than
 * the bound, in the format its name says: a JSON object for a `.json` file,
 * and for a `.toml` one (Devin's) text with at least one `key = value` line.
 * Anything else - an empty answer, a file cut short, a login still half way -
 * is "not signed in yet", never a credential stored broken.
 */
export function parseCredentialFile(output: string, file = "credentials.json"): string | null {
    const value = output.trim();
    if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
    const text = Buffer.from(value, "base64").toString("utf8");
    if (!text || text.length > CREDENTIAL_FILE_MAX) return null;
    if (file.endsWith(".toml")) {
        // Not a TOML parser: enough to tell a written file from an empty or
        // binary one. A table header alone is not a credential.
        if (text.includes("\u0000") || text.includes("�")) return null;
        return /^\s*[A-Za-z0-9_.\-"]+\s*=\s*\S/m.test(text) ? value : null;
    }
    try {
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    } catch {
        return null;
    }
    return value;
}

/**
 * The credential an open login produced, ready to be kept, or null while the
 * login has not finished: the token it printed, for a login that prints one,
 * otherwise the file it wrote. Throws only when the attempt is not this person's.
 */
export async function captureSignin(userId: string, id: string, env: string): Promise<string | null> {
    if (!(env in LOGIN_COMMANDS) || isHomeSignin(env) || signingOut.has(id)) return null;
    // A login kept in an account folder is kept as the folder: its id is what
    // is stored, once the folder is there.
    const folder = folders.folderLoginFor(env);
    if (folder) {
        const output = await runIn(userId, id, whoamiScript(folders.folderPresentCommand(folder.cli.id, id)));
        return output.trim() === id ? id : null;
    }
    if (screens.hasScreenToken(env)) {
        const screen = await runIn(userId, id, signinCaptureCommand());
        return screens.screenTokenIn(env, screens.readSigninScreen(screen).screen);
    }
    const file = signinCredentialFile(env);
    if (!file) return null;
    const pending = directAttempts.get(id);
    if (pending) {
        if (pending.userId !== userId) throw new Error("That sign-in is no longer open.");
        return pending.value;
    }
    return parseCredentialFile(await runIn(userId, id, credentialFileScript(file)), file);
}

// ---------------------------------------------------------------------------
// Whether each home login is signed in
// ---------------------------------------------------------------------------

/** The status command a home login's vendor documents, or null. */
export function signinStatusCommand(env: string): string | null {
    const login = LOGIN_COMMANDS[env];
    return login?.home && login.status ? login.status : null;
}

/** How long one status container may take to answer before every tool in it
 *  reads as unknown. */
const STATUS_TIMEOUT_MS = 45_000;
/** How many status containers run at once across the deployment. Past it a
 *  check answers unknown rather than queueing a container per page view. */
const STATUS_CONCURRENCY = 4;
const statusRuns = new Map<string, Promise<Map<string, status.SigninState>>>();

/**
 * One line per tool: its status command run as the agent, and what it exited
 * with and printed, as `polaris-status <ENV> <code> <base64 output>`. A tool
 * that is not installed in the home is 127 without being run. The commands are
 * catalogue values, never anything typed, and quoted all the same.
 */
export function statusScript(checks: readonly { env: string; command: string }[]): string {
    const lines = checks.flatMap(({ env, command }) => {
        const binary = command.split(" ")[0] ?? "";
        return [
            `if as_agent ${shellQuote(`command -v ${binary}`)} >/dev/null 2>&1; then`,
            `  polaris_out=$(as_agent ${shellQuote(command)} 2>&1) && polaris_code=0 || polaris_code=$?`,
            "else",
            "  polaris_out=; polaris_code=127",
            "fi",
            `printf '${status.STATUS_MARKER} %s %s %s\\n' ${shellQuote(env)} "$polaris_code" "$(printf %s "$polaris_out" | head -c 2048 | base64 -w0)"`
        ];
    });
    return ["{", commands.AGENT_ACCOUNT_SETUP, "} >/dev/null 2>&1", ...lines].join("\n");
}

/** Start a short-lived container on this person's home, run one script in it
 *  as root, and take it away. */
async function runOnHome(userId: string, prefix: string, script: string): Promise<string> {
    const name = `${prefix}-${crypto.randomUUID().slice(0, 12)}`;
    const hostd = new HostdPorts();
    try {
        await upWithFreshImage((pullPolicy) =>
            new HostdPorts().composeUp({
                project: name,
                services: [
                    {
                        name,
                        image: commands.SESSION_IMAGE,
                        pullPolicy,
                        env: { POLARIS_RUNAS: commands.CONTAINER_USER, POLARIS_HOME: commands.AGENT_HOME },
                        ports: [],
                        volumes: [
                            {
                                source: commands.agentHomeSource(userId),
                                target: commands.AGENT_HOME,
                                kind: "bind" as const
                            }
                        ],
                        labels: { [LABEL_KEY]: name },
                        // Ends on its own if the removal below never lands.
                        command: commands.bootArgv("exec sleep 120"),
                        networks: [],
                        restart: "no"
                    }
                ],
                volumes: [],
                networks: []
            }),
            () => new HostdPorts().pull(commands.SESSION_IMAGE)
        );
        const result = await hostd.runIn(name, commands.shellArgv(script));
        return result.output;
    } finally {
        await new HostdPorts().composeDown(name).catch(() => undefined);
    }
}

/** Run every status command at once in one container on this person's home. */
async function runStatusChecks(
    userId: string,
    checks: readonly { env: string; command: string }[]
): Promise<Map<string, status.SigninState>> {
    return status.parseStatusLines(await runOnHome(userId, "polaris-signin-status", statusScript(checks)));
}

/**
 * Clear a stored account's folder (`account-folders.ts`) out of this person's
 * home, as the agent: the sign-out of a login kept in one. Best effort and
 * never throws - the row is already gone, and a folder left behind is a login
 * nothing hands out any more. The id is checked before it is part of a path.
 */
export async function clearAccountFolder(userId: string, env: string, folderId: string): Promise<void> {
    const folder = folders.folderLoginFor(env);
    if (!folder || !folders.isFolderId(folderId)) return;
    try {
        await runOnHome(
            userId,
            "polaris-signin-clear",
            whoamiScript(folders.clearFolderCommand(folder.cli.id, folderId))
        );
    } catch (error) {
        console.warn("[agent-signin] could not clear an account folder:", error instanceof Error ? error.name : "unknown");
    }
}

/** The agents a status read found signed in. */
function inOf(statuses: Record<string, status.SigninStatus>): string[] {
    return Object.entries(statuses)
        .filter(([, one]) => one.state === "in")
        .map(([env]) => env);
}

/** A sign-in or sign-out that finished: remembered for the status, and kept in
 *  the person's list of connected agents (`home-signins`). */
function recordOutcome(userId: string, env: string, mode: "login" | "logout"): void {
    status.recordSigninOutcome(userId, env, mode);
    void homes.markHomeSignin(userId, env, mode === "login").catch((error: unknown) =>
        console.warn("[agent-signin] could not record a connected agent:", error instanceof Error ? error.name : "unknown")
    );
}

/**
 * Each home login's status, by variable.
 *
 * Checked where the vendor documents a status command - one container for all
 * of them, its answers reused for a minute - and the last sign-in or sign-out
 * otherwise. Never throws: a check that fails is "unknown" for the tools in it.
 */
export async function signinStatuses(
    userId: string,
    envs: readonly string[]
): Promise<Record<string, status.SigninStatus>> {
    const now = Date.now();
    const out: Record<string, status.SigninStatus> = {};
    const toCheck: { env: string; command: string }[] = [];
    // Only what the person connected is asked about; the rest of the catalogue
    // is not theirs and costs a container to ask. An account from before the
    // list is checked in full once, and the answer becomes its list.
    const connected = await homes.homeSigninsOf(userId).catch(() => null);
    for (const env of new Set(envs)) {
        if (!isHomeSignin(env)) continue;
        if (connected && !connected.has(env)) {
            out[env] = { state: "out", lastKnown: true };
            continue;
        }
        const command = signinStatusCommand(env);
        if (!command) {
            const known = status.lastKnownStatus(userId, env);
            out[env] = known.state === "unknown" && connected?.has(env) ? { state: "in", lastKnown: true } : known;
            continue;
        }
        const hit = status.cachedStatus(userId, env, now);
        if (hit) out[env] = hit;
        else toCheck.push({ env, command });
    }
    if (toCheck.length === 0) {
        if (connected === null) await homes.setHomeSignins(userId, inOf(out)).catch(() => undefined);
        return out;
    }

    let run = statusRuns.get(userId);
    if (!run && statusRuns.size < STATUS_CONCURRENCY) {
        run = Promise.race([
            runStatusChecks(userId, toCheck),
            new Promise<Map<string, status.SigninState>>((resolve) =>
                setTimeout(() => resolve(new Map()), STATUS_TIMEOUT_MS)
            )
        ])
            .catch((error: unknown) => {
                console.warn("[agent-signin] status check failed:", error instanceof Error ? error.name : "unknown");
                return new Map<string, status.SigninState>();
            })
            .finally(() => statusRuns.delete(userId));
        statusRuns.set(userId, run);
    }
    const answers = run ? await run : new Map<string, status.SigninState>();
    const at = Date.now();
    for (const { env } of toCheck) {
        const state = answers.get(env) ?? "unknown";
        status.cacheStatus(userId, env, state, at);
        // An unanswered check falls back to what the last sign-in said.
        out[env] = state === "unknown" ? status.lastKnownStatus(userId, env) : { state, lastKnown: false };
    }
    if (connected === null) {
        await homes
            .setHomeSignins(userId, inOf(out))
            .catch(() => undefined);
    } else {
        // A login signed in or out outside Polaris, seen by a check.
        for (const { env } of toCheck) {
            const state = answers.get(env);
            if (state === "out") await homes.markHomeSignin(userId, env, false).catch(() => undefined);
        }
    }
    return out;
}
