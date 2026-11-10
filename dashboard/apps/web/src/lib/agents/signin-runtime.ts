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
 * **What is deliberately NOT automated: reading the credential off the screen.**
 * The command prints its result in a shape nobody here has verified, on a stream
 * nobody here has verified, and a parser written against a guess is a parser that
 * silently stores the wrong line - a wrong credential looks exactly like a right
 * one until a session fails at its login prompt a week later. The person is
 * looking straight at it, so they copy it into the field beneath. Polaris does
 * the four things that were hard and leaves the one that was easy.
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
import { agentSignins, type AgentSignin } from "./agent-signins";
import * as screens from "./signin-screen";
import * as direct from "./signin-direct";
import { configuredRequest, readCapped } from "@/lib/safe-fetch";

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
    /** Asked once, after the login, in the same container: the only way a stored
     *  credential can say whose it is. */
    readonly whoami?: string;
    /** First-run answers this login needs on top of the tool's own. */
    readonly firstRun?: readonly core.AgentFirstRunAnswer[];
    /** "device" for a login that prints an address and a code and waits for the
     *  browser, so the dialog shows those two and keeps the terminal folded;
     *  "paste" for one that asks for something typed back into it. */
    readonly flow: SigninFlow;
    /** Questions on the screen Polaris answers itself, once each. */
    readonly autoAnswers?: readonly screens.SigninAutoAnswer[];
}

export type SigninFlow = "device" | "paste";

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
    }
};

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
export function signinFirstRun(env: string): readonly core.AgentFirstRunAnswer[] {
    return [...(cliOf(env)?.firstRun ?? []), ...(LOGIN_COMMANDS[env]?.firstRun ?? [])];
}

function firstRunFor(env: string): string {
    return Buffer.from(commands.firstRunScript(signinFirstRun(env)), "utf8").toString("base64");
}

/** Whether Polaris can run this one's login for somebody, or only take a paste. */
export function canAssistSignin(env: string): boolean {
    return env in LOGIN_COMMANDS;
}

/** The sign-ins Polaris can walk somebody through, for a screen that offers it. */
export function assistedSignins(): AgentSignin[] {
    return agentSignins().filter((signin) => canAssistSignin(signin.env));
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
export async function beginSignin(userId: string, env: string): Promise<SigninAttempt> {
    const login = LOGIN_COMMANDS[env];
    if (!login) throw new Error("Polaris cannot run that sign-in for you.");

    await sweepExpired();
    const running = await prisma.agentSigninAttempt.count({ where: { userId, endedAt: null } });
    if (running >= PER_ACCOUNT) {
        throw new Error("A sign-in is already open. Finish or cancel that one first.");
    }

    const attempt = await prisma.agentSigninAttempt.create({
        data: { userId, env },
        select: { id: true, env: true }
    });

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
    await startContainer(userId, attempt, login);
    return attempt;
}

/** The CLI rung: the vendor's own login in a container. Ends the attempt if the
 *  container cannot be started, since an attempt nobody can reach still counts
 *  against the per-account bound. */
async function startContainer(userId: string, attempt: SigninAttempt, login: LoginCommand): Promise<void> {
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
                            POLARIS_FIRST_RUN: firstRunFor(attempt.env),
                            POLARIS_LOGIN: login.command,
                            POLARIS_RUNAS: commands.CONTAINER_USER,
                            POLARIS_HOME: commands.AGENT_HOME
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

export async function signinScreen(userId: string, id: string): Promise<SigninView> {
    const attempt = await prisma.agentSigninAttempt.findFirst({
        where: { id, userId, endedAt: null },
        select: { env: true }
    });
    if (!attempt) throw new Error("That sign-in is no longer open.");
    const login = LOGIN_COMMANDS[attempt.env];

    const pending = directAttempts.get(id);
    if (pending) return directView(id, attempt.env, pending);
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

    const progress = screens.readSigninScreen(await runIn(userId, id, signinCaptureCommand()));

    const answers = login?.autoAnswers ?? [];
    const reply = screens.pendingAutoAnswer(progress.screen, answers);
    const prompt = answers.find((one) => one.reply === reply)?.prompt;
    const done = answered.get(id) ?? new Set<string>();
    if (reply !== null && prompt && !done.has(prompt)) {
        done.add(prompt);
        answered.set(id, done);
        await answerSignin(userId, id, reply).catch(() => undefined);
    }

    return {
        ...progress,
        ready: progress.screen.trim().length > 0,
        flow: login?.flow ?? "paste",
        rung: "cli",
        fellBack: fellBack.has(id)
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
                startContainer(pending.userId, { id, env }, login)
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
    if (directAttempts.get(id)?.userId === userId) directAttempts.delete(id);
    fellBack.delete(id);
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
        answered.delete(attempt.id);
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
 * decodes back into the home. It has to decode to a JSON object no larger than
 * the bound: anything else - an empty answer, a file cut short, a login still
 * half way - is "not signed in yet", never a credential stored broken.
 */
export function parseCredentialFile(output: string): string | null {
    const value = output.trim();
    if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
    const text = Buffer.from(value, "base64").toString("utf8");
    if (!text || text.length > CREDENTIAL_FILE_MAX) return null;
    try {
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    } catch {
        return null;
    }
    return value;
}

/**
 * The credential file an open login wrote, ready to be kept, or null while the
 * login has not finished. Throws only when the attempt is not this person's.
 */
export async function captureSignin(userId: string, id: string, env: string): Promise<string | null> {
    const file = signinCredentialFile(env);
    if (!file || !(env in LOGIN_COMMANDS)) return null;
    const pending = directAttempts.get(id);
    if (pending) {
        if (pending.userId !== userId) throw new Error("That sign-in is no longer open.");
        return pending.value;
    }
    return parseCredentialFile(await runIn(userId, id, credentialFileScript(file)));
}
