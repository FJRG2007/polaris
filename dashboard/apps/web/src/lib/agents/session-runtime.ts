/**
 * Starting, steering and stopping the process behind a session.
 *
 * The half that touches a machine. Everything it sends is built in
 * `session-commands.ts`, which is pure and tested; this file decides which
 * machine to send it to and carries the credentials there.
 *
 * Two places, one vocabulary. A `local` session is a container on the Polaris box
 * reached through the host daemon, exactly as a deployed service or an agent run
 * is - the web container has no shell on the host and gets a validated compose
 * project or nothing. A `host` session is an enrolled server reached over the
 * same SSH path every other part of Polaris uses to reach one, with the same
 * pinned host key. Neither of them is a new way onto a machine.
 *
 * Every credential travels out of band. The clone token and the session's own
 * reporting token go through the container's environment or a command's standard
 * input, never on a command line - which sshd runs through a shell and which
 * anything able to list processes can read.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { execCommand } from "@polaris/ssh";
import * as commands from "./session-commands";
import { borrowSsh } from "@/lib/connection-pool";
import { appBaseUrl } from "@/lib/domain-service";
import { HostdPorts } from "@/lib/deploy/ports-hostd";
import { getHostConnectionUnscoped } from "@/lib/host-service";
import { credentialsForAgent } from "@/lib/agents/agent-readiness";
import { secretForAccount, sessionSecretsFor } from "@/lib/agents/model-keys";
import { cloneAuthHeader, githubAppInstallationToken } from "@/lib/github-service";
import { claudeHookSettings, hookScript, mcpConfig, shellQuote } from "./session-hooks";
import {
    addSessionMessage,
    finishSession,
    markSessionStarted,
    failureDetail,
    readableFailure,
    resolveSessionEnigma,
    SessionRefusal,
    sessionPlacement,
    type SessionView
} from "./session-service";

/** Stamped on every container a session starts, so the sweep finds them by label
 *  rather than by matching names it does not own. */
const LABEL_KEY = "polaris.agent-session";

/** Where a `local` session's worktree lives inside its own container. */
const CONTAINER_WORKDIR = "/session/repo";

/**
 * Where a WORKSPACE works, which is inside the home that is kept.
 *
 * Deliberately not `/session/repo`. A checkout is disposable - the next session
 * clones it again - and a workspace is the opposite: it is somebody's own
 * directory on their own machine, and files they made there have to still be
 * there tomorrow. The home is the only thing in a session that outlives it, so
 * that is where it goes.
 */
const CONTAINER_WORKSPACE = `${commands.AGENT_HOME}/workspace`;

/** Where a `host` session's worktree lives on an enrolled server. Under one
 *  directory with everything else Polaris puts on a machine, so removing a server
 *  from Polaris leaves one thing to delete. */
function hostWorkdir(sessionId: string): string {
    return `$HOME/.polaris/sessions/${sessionId}/repo`;
}

/** What the machine needs to know to bring a session up. Assembled once and used
 *  by both places, so the two cannot drift on what a session actually is. */
interface Bootstrap {
    readonly repoFullName: string;
    readonly branch: string;
    readonly baseRef: string;
    readonly workdir: string;
    readonly agentBinary: string;
    readonly agentCommand: string;
    readonly agentInstall: string;
    /** What starts the agent, where something other than the shell should.
     *  `enigma` when Enigma is in the session and starts this tool; empty
     *  otherwise, and the boot script falls back to empty on a machine where
     *  the launcher did not install. See `enigmaLaunches`. */
    readonly agentLauncher: string;
    /** The whole of what installing Enigma means, base64 so it survives the
     *  daemon's rule about control characters. Empty when Enigma is off. */
    readonly enigmaSetup: string;
    /** The half that writes into the agent's own home, run as the agent's own
     *  account. Empty when Enigma is off. */
    readonly enigmaConfigure: string;
    /** The tool's own first-run wizard, answered in advance. Empty where the
     *  home is not Polaris's to write into, or where nothing has been sourced
     *  about what the tool asks. See `firstRunScript`. */
    readonly firstRun: string;
    readonly hookScript: string;
    readonly hookSettings: string;
    readonly mcpConfig: string;
    readonly cloneHeader: string;
    readonly githubToken: string;
    /** What signs the agent in, narrowed to the variables its own tool reads.
     *  Empty on a machine where the tool is already signed in, and empty for a
     *  tool Polaris holds no sourced credential for. */
    readonly credentials: Record<string, string>;
    /** What stops it waiting on a menu, where the tool reads a variable for that
     *  rather than taking a flag. */
    readonly autonomyEnv: Record<string, string>;
    /** The unprivileged account the agent runs as, or empty where Polaris does
     *  not own the machine and choosing one would not be its call. */
    readonly runAs: string;
    /** The home that survives this session, or empty on a server - where the
     *  home is the person's own and moving Polaris into it would hijack every
     *  agent they ever start there. See `AGENT_HOME`. */
    readonly home: string;
}

/**
 * What Polaris will run, and how it will watch it.
 *
 * The command is the bare binary for a catalogued tool and whatever the operator
 * typed for a custom one. Nothing per-vendor is appended: a session talks to the
 * agent the way a person would, so the flags are the agent's business and stay
 * out of a list here that would rot in a month.
 */
function agentCommandFor(
    session: SessionView,
    enigmaActive: boolean
): {
    cli: core.AgentCli;
    binary: string;
    command: string;
    install: string;
    launcher: string;
} {
    if (session.cli === core.CUSTOM_AGENT_CLI) {
        const command = (session.command ?? "").trim();
        const cli = core.customAgentCli(command);
        return { cli, binary: cli.binaries[0] ?? "", command, install: "", launcher: "" };
    }
    const cli = core.agentCliById(session.cli);
    if (!cli) throw new SessionRefusal(`Polaris no longer knows an agent called ${session.cli}.`);
    const binary = cli.binaries[0] ?? "";
    // The startup flags decide whether a session does anything at all: without
    // them the tool comes up on its own "do you trust the files in this folder?"
    // menu and waits forever, because the menu reads single keystrokes and the
    // prompt Polaris pastes is not one.
    //
    // But they are also the flags named "dangerously", and where that matters is
    // decided by WHERE this runs rather than by which tool it is. A container
    // Polaris made is a sandbox; somebody's own server is their machine, beside
    // their keys and their Docker socket. `agentRunsUnattended` is that rule, and
    // on a server it says no unless somebody said otherwise on purpose.
    // Not when Enigma is in the session: installing it installs the policies an
    // account keeps for its agents, and what the agent may run without asking is
    // one of the things those settle. Adding a flag on top would be Polaris
    // overruling settings somebody keeps so they do not have to say it twice.
    const args = core.polarisAppliesAutonomy(session.place, session.unattended, enigmaActive)
        ? cli.autonomyArgs
        : [];
    // Through Enigma where Enigma starts this tool, because that launcher is
    // what makes the settings Polaris just stepped aside for actually apply -
    // and what lets one machine hold several logins. See `enigmaLaunches`. The
    // boot script falls back to the bare binary if Enigma is not there, since
    // installing it is best effort and a missing launcher would otherwise be an
    // agent that exits in the same second it starts.
    const launcher = enigmaActive && core.enigmaLaunches(cli.id) ? "enigma" : "";
    return {
        cli,
        binary,
        command: [binary, ...args].join(" "),
        install: cli.install ?? "",
        launcher
    };
}

/**
 * Where the agent works.
 *
 * Three answers rather than two: a checkout on a server, a checkout in a
 * container, and - for a session with no repository - a directory inside the
 * home that is kept, so it is still there the next time.
 */
function workdirFor(session: SessionView): string {
    if (session.place === "host") {
        // On somebody's own server the home already persists, so a workspace
        // there is one directory rather than one per session - otherwise every
        // session would open on an empty one and leave another behind.
        return session.repoFullName ? hostWorkdir(session.id) : "$HOME/.polaris/workspace";
    }
    return session.repoFullName ? CONTAINER_WORKDIR : CONTAINER_WORKSPACE;
}

async function bootstrapFor(session: SessionView, token: string): Promise<Bootstrap> {
    // A workspace checks nothing out, so it needs no installation and asks for
    // no token. Refusing to start one because an organization has not connected
    // GitHub would be refusing over a repository nobody named.
    const owner = session.repoFullName.split("/")[0] ?? "";
    const githubToken = session.repoFullName
        ? ((await githubAppInstallationToken(owner)) ?? "")
        : "";
    if (session.repoFullName && !githubToken) {
        throw new SessionRefusal(
            `Polaris has no GitHub App installation for ${owner}, so it cannot check the repository out. Connect it again under Agents settings.`
        );
    }

    const base = (await appBaseUrl()).replace(/\/+$/, "");
    const ingest = `${base}/api/agents/sessions/${session.id}/events`;
    const mcp = `${base}/api/mcp`;
    const enigma = await resolveSessionEnigma(session.id);
    const agent = agentCommandFor(session, enigma.enabled);
    const chosen = session.accountId
        ? await secretForAccount(session.ownerId, session.accountId)
        : null;

    // Null is the store failing to answer, and it is not the same as an account
    // holding nothing. A session started on a blank environment because the
    // store blinked would come up at a login prompt and look, from every screen,
    // exactly like an agent thinking.
    // Not asked at all when the machine answers for itself: that session wants
    // nothing out of the store, so a store that blinked would be refusing it
    // over credentials the person deliberately declined.
    const available: Record<string, string> | null = session.useMachineLogin
        ? {}
        : await sessionSecretsFor(session.ownerId);
    if (available === null) {
        throw new SessionRefusal(
            "Polaris could not read the stored credentials just now. Try again in a moment."
        );
    }

    return {
        repoFullName: session.repoFullName,
        branch: session.branch,
        baseRef: session.baseRef,
        workdir: workdirFor(session),
        agentBinary: agent.binary,
        agentCommand: agent.command,
        agentInstall: agent.install,
        agentLauncher: agent.launcher,
        // Empty when Enigma is off, which is what the boot script tests for.
        // One script rather than an argv and a second script: it installs the
        // package globally so the agent can invoke `enigma`, then makes the
        // config calls the resolution actually landed on. Neither used to happen
        // - npx threw the download away and every config line after it failed on
        // a command that was not there.
        enigmaSetup: enigma.enabled ? asFile(core.enigmaSetupScript(enigma)) : "",
        enigmaConfigure: enigma.enabled ? asFile(core.enigmaConfigureScript(enigma)) : "",
        // Only into a home Polaris made. A server's home is the person's own,
        // and the tool has been answering these questions there since long
        // before Polaris arrived.
        firstRun:
            session.place === "host" ? "" : asFile(commands.firstRunScript(agent.cli.firstRun)),
        hookScript: hookScript(ingest, token),
        hookSettings: JSON.stringify(
            claudeHookSettings(`${workdirFor(session)}/.claude/polaris-hook.sh`)
        ),
        mcpConfig: JSON.stringify(mcpConfig(mcp, token)),
        // Empty for a workspace, which clones nothing. A header built around an
        // empty token is a header git would send.
        cloneHeader: githubToken ? (cloneAuthHeader(githubToken) ?? "") : "",
        githubToken,
        // The account the person picked wins over whatever would have resolved.
        // Somebody holding three subscriptions chose one of them on the form,
        // and a session that quietly used the first is a session doing the work
        // on a bill they did not pick.
        // Nothing at all when the machine is meant to answer for itself. It is
        // signed in already, in the home that outlives the session, and a stored
        // token injected over that is how a credential somebody revoked months
        // ago comes to beat a login that works - the tool reads the variable
        // first and never looks at the home.
        credentials: session.useMachineLogin
            ? {}
            : chosen
              ? { ...credentialsForAgent(agent.cli, available), [chosen.env]: chosen.secret }
              : credentialsForAgent(agent.cli, available),
        // The same decision, for the tools that take a variable rather than a
        // flag. Held to the same rule so the two halves cannot disagree.
        autonomyEnv: core.polarisAppliesAutonomy(session.place, session.unattended, enigma.enabled)
            ? { ...agent.cli.autonomyEnv }
            : {},
        runAs: session.place === "host" ? "" : commands.CONTAINER_USER,
        home: session.place === "host" ? "" : commands.AGENT_HOME
    };
}

/**
 * A file's contents, as an environment value.
 *
 * The host daemon refuses any environment value carrying a control character,
 * and it is right to: these are rendered into a compose file, and a newline in
 * one of them writes YAML of its own. Every value below that is a FILE has
 * newlines by definition, so each one travels base64-encoded and the boot script
 * decodes it. See the note beside the decode in `session-commands.ts`.
 */
function asFile(contents: string): string {
    return Buffer.from(contents, "utf8").toString("base64");
}

/**
 * The environment the boot script reads. One place, so the container and the
 * server are handed the same names for the same things.
 *
 * The agent's own credential goes in last and is allowed to be absent: a machine
 * where the tool is already signed in needs nothing, and a tool Polaris holds no
 * sourced credential for gets nothing rather than a guess.
 */
function bootEnv(boot: Bootstrap): Record<string, string> {
    return guardEnv({
        GITHUB_REPOSITORY: boot.repoFullName,
        GIT_AUTH_HEADER: boot.cloneHeader,
        GH_TOKEN: boot.githubToken,
        POLARIS_WORKDIR: boot.workdir,
        POLARIS_BRANCH: boot.branch,
        POLARIS_BASE_REF: boot.baseRef,
        POLARIS_TMUX: commands.TMUX_SESSION,
        // Who the agent runs as where Polaris owns the machine. The stock Node
        // image ships this account, and every one of these tools refuses its own
        // skip-permissions flag while running as root. Empty on an enrolled
        // server: there we already are somebody, and choosing a different
        // account on their machine is not Polaris's to do.
        POLARIS_RUNAS: boot.runAs,
        // The home that is kept between sessions, so a sign-in done once is
        // done and the agent installs once rather than every time. Empty on an
        // enrolled server: there the home is somebody's own.
        POLARIS_HOME: boot.home,
        // Whether Polaris is carrying a credential of its own for this tool.
        // Only decides whether the terminal says a word about signing in - a
        // session with nothing linked still works, because the person can sign
        // in in that terminal and the home keeps it.
        POLARIS_SIGNED_IN: Object.keys(boot.credentials).length > 0 ? "1" : "",
        POLARIS_COLS: String(commands.TMUX_COLS),
        POLARIS_ROWS: String(commands.TMUX_ROWS),
        POLARIS_AGENT_BINARY: boot.agentBinary,
        POLARIS_AGENT_COMMAND: boot.agentCommand,
        POLARIS_AGENT_INSTALL: boot.agentInstall,
        POLARIS_AGENT_LAUNCHER: boot.agentLauncher,
        POLARIS_ENIGMA_SETUP: boot.enigmaSetup,
        POLARIS_ENIGMA_CONFIGURE: boot.enigmaConfigure,
        POLARIS_FIRST_RUN: boot.firstRun,
        POLARIS_HOOK_SCRIPT: asFile(boot.hookScript),
        POLARIS_HOOK_SETTINGS: asFile(boot.hookSettings),
        POLARIS_MCP_CONFIG: asFile(boot.mcpConfig),
        ...boot.autonomyEnv,
        ...boot.credentials
    });
}

/**
 * Catch a value the daemon would refuse, here, where it can be said in a
 * sentence.
 *
 * The daemon's rejection names the variable, which is a name nobody outside this
 * file has ever seen, and it arrives as the reason a session failed. The three
 * file-shaped values above are encoded and cannot trip it; what remains is a
 * branch, a repository name or a command somebody typed, and if one of those
 * ever carries a newline the honest thing to say is which of them and that it is
 * a Polaris fault rather than something the reader can fix.
 */
function guardEnv(env: Record<string, string>): Record<string, string> {
    for (const [key, value] of Object.entries(env)) {
        // eslint-disable-next-line no-control-regex
        if (/[\u0000-\u001f\u007f]/.test(value)) {
            throw new Error(
                `Polaris built an unusable value for ${key} and stopped rather than start a broken session.`
            );
        }
    }
    return env;
}

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

/**
 * Bring a session up.
 *
 * Returns once the machine has a process, not once the agent is ready: the agent
 * reports its own readiness through the hooks, and holding this call open for an
 * npm install would tie a click to a minute of somebody else's network.
 */
export async function startSession(session: SessionView, token: string): Promise<void> {
    try {
        const boot = await bootstrapFor(session, token);
        if (session.place === "host") {
            await startOnHost(session, boot);
            await markSessionStarted(session.id, "", boot.workdir);
        } else {
            await startLocally(session, boot);
            await markSessionStarted(
                session.id,
                commands.sessionContainerName(session.id),
                boot.workdir
            );
        }
    } catch (error) {
        // What lands on the session is what somebody will read on it, so the
        // internals of a daemon or an SSH failure stop here. See `readableFailure`.
        // Both: the sentence goes on the session, and what actually happened
        // goes with it. See `failureDetail` - a reason removed from a screen
        // nobody can replace with a log is a reason nobody has.
        await finishSession(
            session.id,
            "failed",
            readableFailure(error, `starting ${session.id}`),
            failureDetail(error)
        );
        throw error;
    }
}

async function startLocally(session: SessionView, boot: Bootstrap): Promise<void> {
    const name = commands.sessionContainerName(session.id);
    await new HostdPorts().composeUp({
        project: name,
        services: [
            {
                name,
                image: commands.SESSION_IMAGE,
                env: bootEnv(boot),
                ports: [],
                // The one thing that outlives the session. See `AGENT_HOME`:
                // the sign-in, the installed tools and Enigma's own settings
                // live here, per account, so the second session starts signed in
                // and in seconds rather than minutes.
                volumes: [
                    {
                        // The machine everybody shares, or this account's own.
                        // Which of the two was settled when the session was
                        // created and is stored on it, so it cannot change
                        // under a session that is already running.
                        //
                        // Otherwise: whoever started it, which is whose
                        // credentials the session spends. A session from before
                        // that was recorded gets a home of its own rather than
                        // joining a shared one - an empty key would put every
                        // such session in the same directory, which is one
                        // person's sign-in in another person's terminal.
                        source: session.sharedHome
                            ? commands.SHARED_HOME_SOURCE
                            : commands.agentHomeSource(session.ownerId ?? `session-${session.id}`),
                        target: commands.AGENT_HOME,
                        kind: "bind" as const
                    }
                ],
                labels: { [LABEL_KEY]: session.id },
                command: commands.bootArgv(commands.SESSION_BOOT),
                networks: [],
                // Never restarted. A session that came back would re-clone over its
                // own worktree and lose whatever the agent had not committed.
                restart: "no"
            }
        ],
        volumes: [],
        networks: []
    });
}

/**
 * Bring a session up on an enrolled server.
 *
 * The whole script, values and all, goes in on standard input. That is the same
 * choice the runner makes for the same reason: sshd runs a command line through a
 * shell where every user on the box can read it, and standard input is not
 * readable there. The values are shell-quoted because they are still going into a
 * shell, just a private one.
 */
async function startOnHost(session: SessionView, boot: Bootstrap): Promise<void> {
    if (!session.hostId) throw new Error("That session names no server to run on.");
    // Unscoped on purpose: which server a session may run on was settled when
    // the session was created, against the account that owns its repository.
    // Re-asking here would need an owner this call does not have, and taking
    // one from the row would be checking a value against itself.
    const host = await getHostConnectionUnscoped(session.hostId);
    const lease = await borrowSsh("exec", host.id, {
        host: host.address,
        port: host.port,
        username: host.username,
        auth: host.auth,
        pinnedHostKey: host.hostKey
    });
    try {
        const assignments = Object.entries(bootEnv(boot))
            .map(([key, value]) => `${key}=${shellQuote(value)}`)
            .join("\n");
        const script = [
            "set -eu",
            assignments,
            `export ${Object.keys(bootEnv(boot)).join(" ")}`,
            'mkdir -p "$(dirname "$POLARIS_WORKDIR")"',
            commands.SESSION_BOOT_FOR_HOST
        ].join("\n");
        // Output is collected rather than returned: the SSH primitive reports the
        // exit code and streams the rest, so what a failure SAID is only knowable
        // if somebody kept it.
        let said = "";
        const keep = (chunk: Buffer): void => {
            if (said.length < 4000) said += chunk.toString("utf8");
        };
        const result = await execCommand(lease.client, "sh -s", {
            input: script,
            onStdout: keep,
            onStderr: keep
        });
        if (result.code !== 0) {
            // What the machine printed goes to the log, not to the screen: it is
            // a shell's stderr, and the one thing it reliably contains is paths.
            // The exception is the boot script's own refusals, which were written
            // to be read - they are the lines that begin `polaris:`.
            console.error(
                `[agent-session] ${session.id} would not start:`,
                said.trim().slice(-2000)
            );
            const spoken = said
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line.startsWith("polaris: "))
                .map((line) => line.slice("polaris: ".length))
                .at(-1);
            throw new SessionRefusal(
                spoken
                    ? spoken.charAt(0).toUpperCase() + spoken.slice(1)
                    : "The server refused to start the session."
            );
        }
    } finally {
        lease.release();
    }
}

// ---------------------------------------------------------------------------
// Steering
// ---------------------------------------------------------------------------

/** Run one of the built commands wherever the session lives. */
async function runInSession(
    sessionId: string,
    command: string,
    /** Whether to reach a session Polaris has already written off. Only the
     *  teardown does: it records the stop before it takes the machine down, so
     *  the one command that has to run after that would otherwise be refused by
     *  the guard that exists to stop somebody steering a dead session. */
    { evenIfFinished = false }: { evenIfFinished?: boolean } = {}
): Promise<{ code: number; output: string }> {
    const placement = await sessionPlacement(sessionId);
    if (!placement) throw new Error("That session no longer exists.");
    if (!evenIfFinished && core.isSessionOver(placement.state))
        throw new Error("That session has ended.");

    if (placement.place === "host") {
        if (!placement.hostId) throw new Error("That session names no server to run on.");
        const host = await getHostConnectionUnscoped(placement.hostId);
        const lease = await borrowSsh("exec", host.id, {
            host: host.address,
            port: host.port,
            username: host.username,
            auth: host.auth,
            pinnedHostKey: host.hostKey
        });
        try {
            let output = "";
            const result = await execCommand(lease.client, "sh -s", {
                input: command,
                onStdout: (chunk) => {
                    if (output.length < 200_000) output += chunk.toString("utf8");
                }
            });
            return { code: result.code, output };
        } finally {
            lease.release();
        }
    }

    if (!placement.containerId)
        throw new Error("That session never got as far as having a container.");
    const result = await new HostdPorts().runIn(placement.containerId, commands.shellArgv(command));
    return { code: result.code, output: result.output };
}

/**
 * Run one of the built commands and insist that it worked.
 *
 * Steering is fire-and-forget by nature - tmux says nothing back about what the
 * agent made of a paste - so the exit code is the only evidence there is that the
 * keystrokes reached a terminal at all. Dropping it makes a prompt that was never
 * delivered indistinguishable from one the agent is already working on, which is
 * the one failure a transcript cannot show.
 */
async function steer(sessionId: string, command: string, whatFor: string): Promise<void> {
    const result = await runInSession(sessionId, command);
    if (result.code === 0) return;
    const said = result.output.trim().slice(-300);
    throw new Error(said ? `${whatFor}: ${said}` : whatFor);
}

/** How long a first prompt waits for the agent to open its terminal. A session
 *  boots by cloning a repository and installing an agent, so the budget is a slow
 *  network's worth of that rather than a click's worth. */
const AGENT_READY_TIMEOUT_MS = 10 * 60 * 1000;
const AGENT_READY_POLL_MS = 5000;

/**
 * Wait until there is a terminal to type into.
 *
 * `startSession` returns as soon as the machine has a process, which is minutes
 * before the agent exists: the boot still has a clone and an install in front of
 * it. Anything sent in that window goes to a tmux session that is not there yet,
 * so the paste fails and the prompt is simply lost. This is what a person does
 * instead - wait for the window to open, then type.
 */
async function waitForAgent(
    sessionId: string,
    timeoutMs = AGENT_READY_TIMEOUT_MS
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        // A session that ended while this was waiting stops it, rather than
        // spending the whole budget on a machine that is gone.
        const placement = await sessionPlacement(sessionId);
        if (!placement) throw new Error("That session no longer exists.");
        if (core.isSessionOver(placement.state)) throw new Error("That session has ended.");
        // A machine part-way through its boot refuses the probe as often as it
        // answers no, and neither one is a reason to stop waiting.
        // Not `tmux has-session`: the setup runs inside that session now, so it
        // exists from the first second and answering on it delivered the prompt
        // into the middle of an install. Not the flag alone either: it is
        // written one line before the launch, and the launcher and the tool's
        // own startup are seconds in which it says yes and there is nothing to
        // type into - which is how a first prompt came to be echoed onto the
        // screen as text. The probe asks the terminal itself.
        const ready = await runInSession(sessionId, commands.agentReadyCommand()).catch(() => null);
        if (ready?.code === 0) return true;
        if (Date.now() + AGENT_READY_POLL_MS >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, AGENT_READY_POLL_MS));
    }
}

/**
 * Send a session something to work on.
 *
 * Two calls with a wait between them, and the wait is the point: the paste has to
 * have reached the agent before the newline that submits it means anything, and
 * sending both at once sends half a prompt. The text is recorded as a message
 * first, so what somebody asked for survives even if the machine has gone away.
 */
export async function promptSession(sessionId: string, text: string): Promise<void> {
    await steer(
        sessionId,
        commands.pastePromptCommand(text),
        "The agent's terminal did not take the prompt"
    );
    await new Promise((resolve) => setTimeout(resolve, commands.submitDelayMs(text)));
    await steer(sessionId, commands.submitCommand(), "The prompt was pasted but not submitted");
}

/**
 * The prompt somebody started a session with, delivered once there is an agent to
 * deliver it to.
 *
 * Separate from `promptSession` because the wait belongs to this one case: every
 * later prompt is typed at a session that is already running, and one of those
 * failing is worth hearing about immediately rather than after ten minutes of
 * polling. Failure is written into the transcript, because the person who typed
 * it has already been told the session started.
 */
export async function deliverFirstPrompt(sessionId: string, text: string): Promise<void> {
    try {
        if (!(await waitForAgent(sessionId))) {
            throw new Error("its agent never opened a terminal to type into");
        }
        await promptSession(sessionId, text);
    } catch (error) {
        await addSessionMessage(
            sessionId,
            "system",
            `Polaris could not send the first prompt: ${error instanceof Error ? error.message : "unknown"}. Send it again from the box below.`
        ).catch(() => undefined);
    }
}

/** Stop what the agent is doing without ending the session. */
export async function interruptSession(sessionId: string): Promise<void> {
    await steer(
        sessionId,
        commands.interruptCommand(),
        "The agent's terminal did not take the interrupt"
    );
}

/** What the agent's terminal currently shows. */
export async function captureSession(sessionId: string, lines = 200): Promise<string> {
    const result = await runInSession(sessionId, commands.captureCommand(lines));
    return result.output;
}

/**
 * End a session and take its machine with it.
 *
 * The container goes; on a server the tmux session is killed and the worktree is
 * left where it is. That asymmetry is deliberate - a container is Polaris's and is
 * disposable, and a directory on somebody's own server holds work they may not
 * have pushed yet. Removing it is theirs to do.
 */
export async function stopSession(sessionId: string): Promise<void> {
    const placement = await sessionPlacement(sessionId);
    if (!placement) return;
    // The decision is recorded before the machine is touched, and that ordering
    // is the whole of why Stop appeared to need pressing twice.
    //
    // Taking a container down is not instant - a stop signal, the grace period
    // it is entitled to, then the network and the volumes - and while that ran,
    // the row still said the session was running. So the screen kept showing a
    // live session and a Stop button for another half a minute after somebody
    // had pressed it, and pressing again was the reasonable thing to do.
    //
    // Nothing is lost by going first. The teardown's failure was already
    // swallowed either way, so this changes when the person is answered rather
    // than whether the machine goes.
    await finishSession(sessionId, "stopped");
    if (placement.place === "host") {
        await runInSession(
            sessionId,
            `tmux kill-session -t ${shellQuote(commands.TMUX_SESSION)} || true`,
            { evenIfFinished: true }
        ).catch(() => undefined);
    } else if (placement.containerId) {
        await new HostdPorts().composeDown(placement.containerId).catch(() => undefined);
    }
}

/**
 * Sessions whose machine has gone quiet for long enough to say so.
 *
 * A session that is thinking hard and one whose container was reaped look
 * identical from here: both are a row that says "working" and has not reported
 * anything. The difference is time, and after enough of it the honest reading is
 * that nobody is going to report anything again.
 */
export async function sweepSilentSessions(maxSilentMs = 6 * 60 * 60 * 1000): Promise<number> {
    const cutoff = new Date(Date.now() - maxSilentMs);
    const stale = await prisma.agentSession.findMany({
        where: {
            state: { notIn: ["stopped", "failed"] },
            OR: [{ lastEventAt: { lt: cutoff } }, { lastEventAt: null, createdAt: { lt: cutoff } }]
        },
        select: { id: true }
    });
    for (const session of stale) {
        await finishSession(
            session.id,
            "failed",
            "The machine running this session stopped reporting."
        );
    }
    return stale.length;
}
