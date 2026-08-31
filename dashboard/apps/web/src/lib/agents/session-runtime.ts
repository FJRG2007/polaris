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
import { borrowSsh } from "@/lib/connection-pool";
import { appBaseUrl } from "@/lib/domain-service";
import { HostdPorts } from "@/lib/deploy/ports-hostd";
import { getHostConnectionUnscoped } from "@/lib/host-service";
import { claudeHookSettings, hookScript, mcpConfig, shellQuote } from "./session-hooks";
import { cloneAuthHeader, githubAppInstallationToken } from "@/lib/github-service";
import {
    finishSession,
    markSessionStarted,
    resolveSessionEnigma,
    sessionPlacement,
    type SessionView
} from "./session-service";
import * as commands from "./session-commands";

/** Stamped on every container a session starts, so the sweep finds them by label
 *  rather than by matching names it does not own. */
const LABEL_KEY = "polaris.agent-session";

/** Where a `local` session's worktree lives inside its own container. */
const CONTAINER_WORKDIR = "/session/repo";

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
    readonly workdir: string;
    readonly agentBinary: string;
    readonly agentCommand: string;
    readonly agentInstall: string;
    readonly enigmaArgv: string;
    readonly hookScript: string;
    readonly hookSettings: string;
    readonly mcpConfig: string;
    readonly cloneHeader: string;
    readonly githubToken: string;
}

/**
 * What Polaris will run, and how it will watch it.
 *
 * The command is the bare binary for a catalogued tool and whatever the operator
 * typed for a custom one. Nothing per-vendor is appended: a session talks to the
 * agent the way a person would, so the flags are the agent's business and stay
 * out of a list here that would rot in a month.
 */
function agentCommandFor(session: SessionView): { binary: string; command: string; install: string } {
    if (session.cli === core.CUSTOM_AGENT_CLI) {
        const command = (session.command ?? "").trim();
        return { binary: core.customAgentCli(command).binaries[0] ?? "", command, install: "" };
    }
    const cli = core.agentCliById(session.cli);
    if (!cli) throw new Error(`Polaris no longer knows an agent called ${session.cli}.`);
    const binary = cli.binaries[0] ?? "";
    return { binary, command: binary, install: cli.install ?? "" };
}

async function bootstrapFor(session: SessionView, token: string): Promise<Bootstrap> {
    const owner = session.repoFullName.split("/")[0] ?? "";
    const githubToken = await githubAppInstallationToken(owner);
    if (!githubToken) {
        throw new Error(`Polaris has no GitHub App installation for ${owner}, so it cannot check the repository out.`);
    }

    const base = (await appBaseUrl()).replace(/\/+$/, "");
    const ingest = `${base}/api/agents/sessions/${session.id}/events`;
    const mcp = `${base}/api/mcp`;
    const enigma = await resolveSessionEnigma(session.id);
    const agent = agentCommandFor(session);

    return {
        repoFullName: session.repoFullName,
        branch: session.branch,
        workdir: session.place === "host" ? hostWorkdir(session.id) : CONTAINER_WORKDIR,
        agentBinary: agent.binary,
        agentCommand: agent.command,
        agentInstall: agent.install,
        // Empty when Enigma is off, which is what the boot script tests for.
        enigmaArgv: enigma.enabled ? core.enigmaInstallArgv(enigma).join(" ") : "",
        hookScript: hookScript(ingest, token),
        hookSettings: JSON.stringify(claudeHookSettings(`${session.place === "host" ? hostWorkdir(session.id) : CONTAINER_WORKDIR}/.claude/polaris-hook.sh`)),
        mcpConfig: JSON.stringify(mcpConfig(mcp, token)),
        cloneHeader: cloneAuthHeader(githubToken) ?? "",
        githubToken
    };
}

/** The environment the boot script reads. One place, so the container and the
 *  server are handed the same names for the same things. */
function bootEnv(boot: Bootstrap): Record<string, string> {
    return {
        GITHUB_REPOSITORY: boot.repoFullName,
        GIT_AUTH_HEADER: boot.cloneHeader,
        GH_TOKEN: boot.githubToken,
        POLARIS_WORKDIR: boot.workdir,
        POLARIS_BRANCH: boot.branch,
        POLARIS_TMUX: commands.TMUX_SESSION,
        POLARIS_COLS: String(commands.TMUX_COLS),
        POLARIS_ROWS: String(commands.TMUX_ROWS),
        POLARIS_AGENT_BINARY: boot.agentBinary,
        POLARIS_AGENT_COMMAND: boot.agentCommand,
        POLARIS_AGENT_INSTALL: boot.agentInstall,
        POLARIS_ENIGMA_ARGV: boot.enigmaArgv,
        POLARIS_HOOK_SCRIPT: boot.hookScript,
        POLARIS_HOOK_SETTINGS: boot.hookSettings,
        POLARIS_MCP_CONFIG: boot.mcpConfig
    };
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
            await markSessionStarted(session.id, commands.sessionContainerName(session.id), boot.workdir);
        }
    } catch (error) {
        await finishSession(session.id, "failed", error instanceof Error ? error.message : "It would not start");
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
                volumes: [],
                labels: { [LABEL_KEY]: session.id },
                command: ["sh", "-c", commands.SESSION_BOOT],
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
            SESSION_BOOT_FOR_HOST
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
            throw new Error(said.trim().slice(-400) || "The server refused to start the session.");
        }
    } finally {
        lease.release();
    }
}

/**
 * The boot script, minus the parts that only make sense in a container.
 *
 * A server is somebody's machine: Polaris does not install packages on it, does
 * not park a foreground process on it, and says so plainly when tmux is missing
 * rather than reaching for a package manager it was never given permission to
 * use. The tmux session it starts outlives the SSH connection that started it,
 * which is the whole reason this shape works over SSH at all.
 */
const SESSION_BOOT_FOR_HOST = commands.SESSION_BOOT.split("\n")
    .filter(
        (line) =>
            !line.includes("apt-get") &&
            !line.startsWith("if ! command -v tmux") &&
            line !== "fi" &&
            !line.startsWith("exec tail -f")
    )
    .join("\n");

// ---------------------------------------------------------------------------
// Steering
// ---------------------------------------------------------------------------

/** Run one of the built commands wherever the session lives. */
async function runInSession(sessionId: string, command: string): Promise<{ code: number; output: string }> {
    const placement = await sessionPlacement(sessionId);
    if (!placement) throw new Error("That session no longer exists.");
    if (core.isSessionOver(placement.state)) throw new Error("That session has ended.");

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

    if (!placement.containerId) throw new Error("That session never got as far as having a container.");
    const result = await new HostdPorts().runIn(placement.containerId, commands.shellArgv(command));
    return { code: result.code, output: result.output };
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
    await runInSession(sessionId, commands.pastePromptCommand(text));
    await new Promise((resolve) => setTimeout(resolve, commands.submitDelayMs(text)));
    await runInSession(sessionId, commands.submitCommand());
}

/** Stop what the agent is doing without ending the session. */
export async function interruptSession(sessionId: string): Promise<void> {
    await runInSession(sessionId, commands.interruptCommand());
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
    if (placement.place === "host") {
        await runInSession(sessionId, `tmux kill-session -t ${shellQuote(commands.TMUX_SESSION)} || true`).catch(
            () => undefined
        );
    } else if (placement.containerId) {
        await new HostdPorts().composeDown(placement.containerId).catch(() => undefined);
    }
    await finishSession(sessionId, "stopped");
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
        await finishSession(session.id, "failed", "The machine running this session stopped reporting.");
    }
    return stale.length;
}
