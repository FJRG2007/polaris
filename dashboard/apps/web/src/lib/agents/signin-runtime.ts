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

import { prisma } from "@polaris/db";
import * as commands from "./session-commands";
import { HostdPorts } from "@/lib/deploy/ports-hostd";
import { agentSignins, type AgentSignin } from "./agent-signins";

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
const LOGIN_COMMANDS: Readonly<Record<string, { install: string; command: string; whoami?: string }>> = {
    CLAUDE_CODE_OAUTH_TOKEN: {
        // The same install line the catalogue uses, --allow-scripts and all:
        // npm now declines a package's postinstall unless it is named, and this
        // one's postinstall is what puts the binary on the PATH.
        install: "npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code",
        command: "claude setup-token",
        // Asked once, after the login, in the same container. It is the only way
        // a stored credential can say whose it is - and without that, an account
        // holding two of them has two rows called the same thing and no way to
        // tell which subscription is behind either.
        whoami: "claude auth status --json"
    }
};

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
    // Through a file rather than nested quoting: the login is a value from the
    // catalogue, and `su -p node -c "<it>"` inside a tmux argument is three
    // levels of quoting to get wrong once.
    "printf '%s' \"$POLARIS_LOGIN\" > /tmp/polaris-login.sh",
    "chmod 0755 /tmp/polaris-login.sh",
    // A shell after it, so the screen survives the command. Without that the
    // window closed the moment the login printed its result, which is the one
    // moment somebody needed to be reading it.
    "POLARIS_RUN='sh /tmp/polaris-login.sh; exec sh'",
    'if [ "$POLARIS_AS_ROOT" = "yes" ]; then',
    "  POLARIS_RUN=\"su -p $POLARIS_RUNAS -c 'sh /tmp/polaris-login.sh; exec sh'\"",
    "fi",
    'tmux new-session -d -s "$POLARIS_TMUX" -x "$POLARIS_COLS" -y "$POLARIS_ROWS" "$POLARIS_RUN"',
    "exec tail -f /dev/null"
].join("\n");

/** One attempt in flight. */
export interface SigninAttempt {
    readonly id: string;
    readonly env: string;
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
    try {
        const name = containerName(attempt.id);
        await new HostdPorts().composeUp({
            project: name,
            services: [
                {
                    name,
                    image: commands.SESSION_IMAGE,
                    env: {
                        POLARIS_TMUX: TMUX,
                        POLARIS_COLS: String(commands.SIGNIN_COLS),
                        POLARIS_ROWS: String(commands.SIGNIN_ROWS),
                        POLARIS_INSTALL: login.install,
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
        });
        return attempt;
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
export interface SigninView {
    readonly screen: string;
    readonly url: string | null;
    readonly ready: boolean;
}

export async function signinScreen(userId: string, id: string): Promise<SigninView> {
    const screen = await runIn(userId, id, commands.captureJoinedCommand(60, TMUX));
    const trimmed = screen.trim();
    return { screen, url: commands.firstUrlIn(screen), ready: trimmed.length > 0 };
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
        record.account && typeof record.account === "object" ? (record.account as Record<string, unknown>) : {};

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
 * Ask the container who just signed in.
 *
 * Best effort by design: it runs after the credential is already in somebody's
 * hand, so a tool that will not answer costs a label on a row rather than the
 * login. Returns an empty identity for every failure there is - no command for
 * this credential, a container already gone, a version that prints prose.
 */
export async function identifySignin(userId: string, id: string, env: string): Promise<SigninIdentity> {
    const command = LOGIN_COMMANDS[env]?.whoami;
    if (!command) return {};
    try {
        return parseSigninIdentity(await runIn(userId, id, command));
    } catch {
        return {};
    }
}
