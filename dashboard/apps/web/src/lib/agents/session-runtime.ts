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

import { cliPolicyFile, POLICY_PATHS } from "@/lib/polar/agents/cli-policies";
import * as toolsMcp from "@/lib/agents/session-tools-mcp";
import * as browserMcp from "@/lib/agents/session-browser-mcp";
import * as browserProtocol from "@/lib/agents/session-browser-protocol";
import { browserKey } from "@/lib/agents/session-browser-link";
import { claudePermissionSettings, configFromRules, rulesOf, type PermissionRule } from "@/lib/polar/agents/permissions";
import { repoAgentFiles, sessionAgentFiles } from "@/lib/polar/agents/repo-agents";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { execCommand } from "@polaris/ssh";
import * as commands from "./session-commands";
import * as accountHomes from "./account-homes";
import * as acpPipe from "./acp/pipe-commands";
import * as acpTransport from "./acp/transport";
import * as acpProviders from "./acp/providers";
import * as acpDrivers from "./acp/session-drivers";
import * as handoff from "./acp/handoff";
import { AcpRefusal } from "./acp/session-driver";
import { CodexAppServerMissing } from "./codex/session-driver";
import { touchSession } from "./session-live";
import { borrowSsh } from "@/lib/connection-pool";
import { appBaseUrl } from "@/lib/domain-service";
import { containerState, withContainerPorts } from "./session-ports";
import { getHostConnectionUnscoped } from "@/lib/host-service";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { sessionCredentials } from "@/lib/agents/agent-readiness";
import { ANTHROPIC_HEADERS_ENV } from "@/lib/agents/agent-providers";
import { chatCredentialFor, secretForAccount, sessionSecretsFor } from "@/lib/agents/model-keys";
import { opencodeModelEnv } from "@/lib/agents/opencode-model";
import * as attachments from "@/lib/agents/session-attachments";
import {
    GitHubStatusError,
    cloneAuthHeader,
    githubAppInstallationToken
} from "@/lib/github-service";
import * as scoping from "@/lib/github-installation-scope";
import {
    claudeHookSettings,
    gitCredentialScript,
    hookScript,
    mcpConfig,
    shellQuote
} from "./session-hooks";
import * as fork from "./session-fork";
import * as memory from "./session-memory";
import { skillsSyncScript } from "./session-skills";
import { endContainerSession, type SaveOutcome } from "./session-work";
import { clearSessionWaiting, noticeSessionEnded } from "./agent-notices";
import { syncFinalSessionHistory } from "./session-history";
import { totalCeiling } from "./session-capacity";
import { startContainer } from "./session-container";
import { claimSpare } from "./session-spares";
import { previewBase } from "./session-preview-link";
import * as placement from "./session-placement";
import * as snapshots from "./session-snapshots";
import * as computer from "@/lib/computers/computer-sessions";
import { withCues } from "@/lib/agents/session-cues";
import { computerSessionRunner, runComputerSnapshot } from "@/lib/computers/computer-workspace";
import {
    addSessionMessage,
    finishSession,
    forkSource,
    markSessionStarted,
    failureDetail,
    readableFailure,
    reissueSessionToken,
    resolveSessionEnigma,
    SessionRefusal,
    sessionPlacement,
    sessionViewById,
    type SessionView
} from "./session-service";


/** Where a `local` session's worktree used to live inside its own container,
 *  for every repository alike. Still what a repository name Polaris cannot key
 *  falls back to; every other checkout is `memory.repoCheckoutDir`, a path of
 *  the repository's own, so the stores the agent keys by its path are that
 *  repository's (see session-memory.ts). Both sit on the session's own
 *  directory on the box, so they outlive the container. See
 *  `sessionCheckoutSource`. */
const CONTAINER_WORKDIR = `${commands.SESSION_ROOT}/repo`;

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

/**
 * Where Polaris keeps its own files for a session: the hook script, the hook
 * settings and the MCP registration, two of which carry the session's token.
 *
 * Never inside the checkout, where a tracked `.mcp.json` would be overwritten
 * and the token would be one `git add -A` from a push, and never in the home,
 * which on a server is somebody's own. Per session, so two sessions of one
 * account never read each other's token.
 */
function stateDirFor(session: { id: string; place: string }): string {
    return session.place === "host"
        ? `$HOME/.polaris/sessions/${session.id}/polaris`
        : `${commands.SESSION_ROOT}/polaris`;
}

/** What the machine needs to know to bring a session up. Assembled once and used
 *  by both places, so the two cannot drift on what a session actually is. */
interface Bootstrap {
    readonly repoFullName: string;
    readonly branch: string;
    readonly baseRef: string;
    readonly workdir: string;
    /** Polaris's own files for the session. See `stateDirFor`. */
    readonly stateDir: string;
    /** `claude` when the agent takes its hooks and MCP servers from flags. */
    readonly agentConfig: string;
    readonly agentBinary: string;
    readonly agentCommand: string;
    readonly agentInstall: string;
    /** What starts the agent, where something other than the shell should.
     *  `enigma` when Enigma is in the session and starts this tool; empty
     *  otherwise, and the boot script falls back to empty on a machine where
     *  the launcher did not install. See `enigmaLaunches`. */
    readonly agentLauncher: string;
    /** How the tool reopens a conversation, or empty. See `agentResumeStyle`. */
    readonly agentResume: string;
    /** The flags that run one turn without the tool's interface, or empty for a
     *  tool that keeps its interactive terminal. See `AgentCli.headless`. */
    readonly agentHeadless: string;
    /** The parent's transcript a fork reopens, or empty. See `forkTranscript`. */
    readonly agentFork: string;
    /** The arguments that load the activity hook the first run wrote, added by
     *  the launch script unless the boot found the build refuses them. Empty
     *  where nothing was written. See `AgentCli.hookArgs`. */
    readonly agentHookArgs: string;
    /** The flag the boot checks the tool's help for first, or empty to add
     *  them unchecked. See `AgentCli.hookProbe`. */
    readonly agentHookProbe: string;
    /** A hook configuration of the session's own, written into the state
     *  directory at boot, and the variable that points the tool at it. Null
     *  for every tool but the ones that read one. See `sessionHookConfig`. */
    readonly agentHookConfig: { readonly path: string; readonly env: string; readonly contents: string } | null;
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
    readonly memorySync: string;
    /** The script that fetches the person's Polar skills into the home before
     *  the agent starts (`session-skills.ts`). Empty where the home is not one
     *  person's for Polaris to write into. */
    readonly skillsSync: string;
    /** `ENV=relative/path` pairs, space separated: which of `credentials` are
     *  a file the tool keeps, and where. Names and paths from the catalogue. */
    readonly credentialFiles: string;
    readonly mcpConfig: string;
    /** `mcpConfig` with the custom tools' server beside Polaris's own. The
     *  boot writes it instead where the machine has `node` to run it with. */
    readonly mcpToolsConfig: string;
    /** The custom tools' stdio MCP server (session-tools-mcp.ts). */
    readonly toolsServer: string;
    /** The worker browser's stdio MCP server (session-browser-mcp.ts), or
     *  empty where the session is not a container Polaris can dial. */
    readonly browserServer: string;
    readonly cloneHeader: string;
    /** The credential helper script, or empty for a workspace. */
    readonly gitCredential: string;
    /** The repository's own setup script, encoded, or empty for none. */
    readonly repoSetup: string;
    /** Whether a failing setup script stops the session before the agent starts. */
    readonly repoSetupRequired: boolean;
    /** The repository's .polaris/agents as the coding tools' own agent files
     *  (`sessionAgentFiles`), JSON in base64, or empty for none. */
    readonly repoAgents: string;
    /** The agent's permission rules as the tool's own policy file in its home
     *  (`cliPolicyFile`), base64, or empty for none; the path is the tool's
     *  fixed one, set for Codex and Gemini even without rules, so a file an
     *  earlier session left there is taken away. */
    readonly agentPolicy: string;
    readonly agentPolicyPath: string;
    /** The path on Polaris's address a web server in the container is previewed
     *  under, a port after it. Empty where there is no preview: a session on
     *  somebody's own account on a server. See `session-preview`. */
    readonly previewBase: string;
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
    // A mode somebody picked for this session wins over both: it is the one
    // thing here that was chosen for this work rather than for every session.
    // With bypass allowed but not on, so a mode changed mid-session can reach
    // every one Polaris offers (see `permissionModeCommand`).
    const picked = core.permissionModeArgs(cli.id, session.permissionMode);
    const chosen = picked ? [...picked, "--allow-dangerously-skip-permissions"] : null;
    const args =
        chosen ??
        (core.polarisAppliesAutonomy(session.place, session.unattended, enigmaActive)
            ? cli.autonomyArgs
            : []);
    // Through Enigma where Enigma starts this tool, because that launcher is
    // what makes the settings Polaris just stepped aside for actually apply -
    // and what lets one machine hold several logins. See `enigmaLaunches`. The
    // boot script falls back to the bare binary if Enigma is not there, since
    // installing it is best effort and a missing launcher would otherwise be an
    // agent that exits in the same second it starts.
    const launcher = enigmaActive && core.enigmaLaunches(cli.id) ? "enigma" : "";
    // The model picked for this session, on the flag the tool documents. Held
    // to SAFE_MODEL_ID again there: the command is one line of words.
    const modelArgs = core.agentModelArgs(cli.id, session.modelChoice?.model);
    // The effort picked for this session, on the flag the tool documents; only
    // a level that tool lists ever reaches the line.
    const effortArgs = core.agentEffortArgs(cli.id, session.effort);
    // The subcommand its interactive session starts with, first whatever else
    // is on the line.
    const launchArgs = cli.launchArgs ?? [];
    return {
        cli,
        binary,
        command: [binary, ...launchArgs, ...args, ...modelArgs, ...effortArgs].join(" "),
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
    if (!session.repoFullName) return CONTAINER_WORKSPACE;
    return memory.memoryKey(session.repoFullName) ? memory.repoCheckoutDir(session.repoFullName) : CONTAINER_WORKDIR;
}

/**
 * Whether a session carries its agent's memory of the repository between
 * boxes, and where that memory lives. Only where Polaris owns the home and it
 * is one person's: a server's home is already its owner's own, and a machine
 * everybody shares would hand one person's memory to the next. Must agree
 * with `sessionMemoryScope`, which is what the endpoint authorises by.
 */
function memoryDirFor(session: SessionView): string {
    if (session.place !== "local" || session.sharedHome || !session.ownerId || !session.repoFullName) return "";
    return memory.memoryKey(session.repoFullName) ? memory.repoMemoryDir(session.repoFullName) : "";
}

/** The parent's transcript a forked session reopens, or empty for any other. */
async function forkTranscriptFor(session: SessionView, cli: string): Promise<string> {
    if (!session.parentId) return "";
    const parent = await forkSource(session.parentId);
    if (!parent) return "";
    return fork.forkTranscript({ ...session, cli }, parent);
}

/** Whether a fork's own agent reopens its parent's conversation, so it needs
 *  no handoff note to know it. */
export async function reopensParentConversation(session: SessionView): Promise<boolean> {
    return (await forkTranscriptFor(session, session.cli)) !== "";
}

async function bootstrapFor(session: SessionView, token: string): Promise<Bootstrap> {
    // A workspace checks nothing out, so it needs no installation and asks for
    // no token. Refusing to start one because an organization has not connected
    // GitHub would be refusing over a repository nobody named.
    const githubToken = session.repoFullName ? await cloneToken(session.repoFullName) : "";
    const setup = session.repoId ? await repoSetupFor(session.repoId) : null;
    const agentFiles = await repoAgentFilesFor(session, githubToken);

    const base = (await appBaseUrl()).replace(/\/+$/, "");
    const ingest = `${base}/api/agents/sessions/${session.id}/events`;
    const mcp = `${base}/api/mcp`;
    const credential = `${base}/api/agents/sessions/${session.id}/git-credential`;
    const enigma = await resolveSessionEnigma(session.id);
    const agent = agentCommandFor(session, enigma.enabled);
    const credentials = await credentialEnvFor(session, agent.cli);
    const memoryDir = memoryDirFor(session);
    // Only the tools whose turn flags were checked against their own docs.
    const headless = agent.cli.headless?.join(" ") ?? "";

    return {
        repoFullName: session.repoFullName,
        branch: session.branch,
        baseRef: session.baseRef,
        workdir: workdirFor(session),
        stateDir: stateDirFor(session),
        // Claude takes its hooks and its MCP servers from flags, so Polaris's
        // own files never have to be written into the repository.
        agentConfig: agent.cli.id === "claude" ? "claude" : "",
        agentBinary: agent.binary,
        agentCommand: agent.command,
        agentInstall: agent.install,
        agentLauncher: agent.launcher,
        agentResume: core.agentResumeStyle(agent.cli.id),
        agentHeadless: headless,
        agentFork: await forkTranscriptFor(session, agent.cli.id),
        // The extension or agent that reports this session's activity, for a
        // tool that only loads one it is pointed at. Only where the first run
        // wrote it: on somebody's own server it was never written, and a
        // missing extension is an agent that will not start.
        agentHookArgs: session.place === "host" ? "" : (agent.cli.hookArgs ?? []).join(" "),
        agentHookProbe: session.place === "host" ? "" : (agent.cli.hookProbe ?? ""),
        agentHookConfig:
            session.place === "host"
                ? null
                : sessionHookConfig(agent.cli.id, stateDirFor(session), {
                      webhook: `${base}/api/agents/sessions/${session.id}/codewhale?token=${encodeURIComponent(token)}`
                  }),
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
        credentialFiles: agent.cli.credentials
            .filter((credential) => credential.file)
            .map((credential) => `${credential.env}=${credential.file}`)
            .join(" "),
        // Only Claude Code's permission prompt is answered from Polaris: the
        // decision it prints back is Claude Code's own shape, and another
        // tool's hook would read it as something else.
        hookScript: hookScript(
            ingest,
            token,
            agent.cli.id === "claude" ? `${base}/api/agents/sessions/${session.id}/permission` : undefined,
            { memorySync: memoryDir !== "" }
        ),
        hookSettings: JSON.stringify(
            claudeHookSettings(`${stateDirFor(session)}/hook.sh`, {
                headless: headless !== "",
                memoryDir,
                permissions:
                    agent.cli.id === "claude" ? claudePermissionSettings(await agentRulesFor(session.id)) : null
            })
        ),
        // The script that restores the repository's memory before the agent
        // starts and carries it back after each turn. Empty where none is kept.
        memorySync: memoryDir
            ? memory.memorySyncScript({
                  url: `${base}/api/agents/sessions/${session.id}/memory`,
                  token,
                  workdir: workdirFor(session),
                  memoryDir,
                  handoffDir: memory.HANDOFF_DIR
              })
            : "",
        // The person's skills as set up in Polar, edits included. Only where
        // Polaris owns the home and it is one person's, as with memory; must
        // agree with the endpoint, which authorises by the same rule.
        skillsSync:
            session.place === "local" && !session.sharedHome && session.ownerId
                ? skillsSyncScript({ url: `${base}/api/agents/sessions/${session.id}/skills`, token })
                : "",
        mcpConfig: JSON.stringify(mcpConfig(mcp, token)),
        mcpToolsConfig: JSON.stringify(
            mcpConfig(mcp, token, {
                script: `${toolsMcp.STATE_DIR_MARK}/${toolsMcp.TOOLS_SERVER_FILE}`,
                url: `${base}/api/agents/sessions/${session.id}/tools`
            }, session.place === "local"
                ? {
                      script: `${toolsMcp.STATE_DIR_MARK}/${browserProtocol.BROWSER_SERVER_FILE}`,
                      key: browserKey(session.id),
                      install: true
                  }
                : undefined)
        ),
        toolsServer: toolsMcp.toolsMcpScript(),
        // Only a container: the live view dials it on its private network
        // (session-preview.ts), which a server's own account does not have.
        browserServer: session.place === "local" ? browserMcp.browserMcpScript() : "",
        // Empty for a workspace, which clones nothing. A header built around an
        // empty token is a header git would send.
        cloneHeader: githubToken ? (cloneAuthHeader(githubToken) ?? "") : "",
        // Not a token: a script that asks for one. The agent's environment holds
        // no GitHub credential at all.
        gitCredential: session.repoFullName ? gitCredentialScript(credential, token) : "",
        repoSetup: setup?.setupScript.trim() ? asFile(setup.setupScript) : "",
        repoSetupRequired: setup?.setupRequired ?? false,
        repoAgents: agentFiles,
        // Only into a home Polaris made, as with the first run: a server's
        // home is the person's own, and its policies are theirs.
        ...agentPolicyFor(session.place === "host" ? null : agent.cli.id, await agentRulesFor(session.id)),
        previewBase: session.place === "local" ? previewBase(session.id) : "",
        // The account the person picked wins over whatever would have resolved.
        // Somebody holding three subscriptions chose one of them on the form,
        // and a session that quietly used the first is a session doing the work
        // on a bill they did not pick.
        // Nothing at all when the machine is meant to answer for itself. It is
        // signed in already, in the home that outlives the session, and a stored
        // token injected over that is how a credential somebody revoked months
        // ago comes to beat a login that works - the tool reads the variable
        // first and never looks at the home.
        credentials,
        // The same decision, for the tools that take a variable rather than a
        // flag. Held to the same rule so the two halves cannot disagree.
        autonomyEnv: core.permissionModeArgs(agent.cli.id, session.permissionMode) === null &&
            core.polarisAppliesAutonomy(session.place, session.unattended, enigma.enabled)
            ? { ...agent.cli.autonomyEnv }
            : {},
        runAs: session.place === "host" ? "" : commands.CONTAINER_USER,
        home: session.place === "host" ? "" : commands.AGENT_HOME
    };
}

/**
 * What the agent signs in with, resolved from the accounts as they are now: the
 * one the session picked, else whatever resolves, then the provider and model
 * picked on the form. Shared by the boot and by the refresh before every turn,
 * so the two cannot disagree on what a session is handed.
 */
async function credentialEnvFor(
    session: SessionView,
    cli: core.AgentCli
): Promise<Record<string, string>> {
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
        ...sessionCredentials(cli, available, chosen, session.useMachineLogin),
        // The provider and model picked on the form, last, so they win.
        ...withOpencodePermission(cli.id, await modelEnvFor(session), await agentRulesFor(session.id))
    };
}

/** The boot's policy file for a tool that reads its rules from one. */
export function agentPolicyFor(
    cli: string | null,
    rules: readonly PermissionRule[]
): { agentPolicy: string; agentPolicyPath: string } {
    if (cli !== "codex" && cli !== "gemini") return { agentPolicy: "", agentPolicyPath: "" };
    const file = cliPolicyFile(cli, rules);
    return { agentPolicy: file ? asFile(file.contents) : "", agentPolicyPath: POLICY_PATHS[cli] };
}

/** The Polar agent's rules a session was started with; none when unreadable. */
async function agentRulesFor(sessionId: string): Promise<PermissionRule[]> {
    const row = await prisma.agentSession
        .findUnique({ where: { id: sessionId }, select: { agentPermission: true } })
        .catch(() => null);
    return rulesOf(row?.agentPermission);
}

/**
 * OpenCode reads the rules as its own `permission` config, in
 * `OPENCODE_CONFIG_CONTENT` beside the model when there is one. Other tools'
 * variables pass through untouched.
 */
export function withOpencodePermission(
    cli: string,
    env: Record<string, string>,
    rules: readonly PermissionRule[]
): Record<string, string> {
    if (cli !== "opencode" || rules.length === 0) return env;
    let config: Record<string, unknown> = { $schema: "https://opencode.ai/config.json" };
    try {
        if (env.OPENCODE_CONFIG_CONTENT) config = JSON.parse(env.OPENCODE_CONFIG_CONTENT) as Record<string, unknown>;
    } catch {
        // Ours, and always JSON; a broken one is replaced whole.
    }
    return { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, permission: configFromRules(rules) }) };
}

/**
 * Hand the session's next turn the credentials as they are now.
 *
 * The boot environment is fixed when the machine starts, so without this a
 * session kept a credential somebody has since replaced or removed - and the
 * tool reads a stale API key before the sign-in it was meant to use. Resolved
 * through the same path as the boot, written into the state directory (see
 * `commands.CREDENTIALS_FILE`), and read by the launch script right before the
 * agent starts. Every variable the tool reads is cleared first, so one that is
 * gone does not survive from the boot. File-shaped credentials stay as the boot
 * wrote them: the tool reads those from its home, not from the environment -
 * except a pinned account of a tool with account homes (Codex), which runs in
 * that account's own home so a switch or a rotation reaches the next launch.
 *
 * Never fails the prompt it runs before: a store that blinked, a machine that
 * did not answer or a session that is still booting keeps the credentials it
 * has, and the reason goes to the log.
 */
export async function refreshCredentials(sessionId: string): Promise<void> {
    try {
        // Both reads at once: this runs before every prompt, ahead of the agent.
        const [session, placement] = await Promise.all([
            sessionViewById(sessionId),
            sessionPlacement(sessionId)
        ]);
        // A computer's tools use that machine's own sign-ins: nothing is sent.
        if (!session || !placement || placement.place === "computer" || core.isSessionOver(placement.state)) return;
        const cli = agentCommandFor(session, false).cli;
        const fresh = await credentialEnvFor(session, cli);
        const files = new Set(
            cli.credentials.filter((entry) => entry.file).map((entry) => entry.env)
        );
        const env: Record<string, string> = Object.fromEntries(
            Object.entries(fresh).filter(([name]) => !files.has(name))
        );
        const stateDir = stateDirFor(placement);
        // A pinned account of a tool that keeps its sign-in in a file runs in
        // that account's own home (`account-homes.ts`), so a switch or a
        // rotation reaches the next launch. Only in a container: on somebody's
        // own server the tool's home is theirs and is never touched.
        const home = placement.place === "host" ? null : accountHomes.accountHomeFor(cli.id);
        const signin = home ? cli.credentials.find((entry) => entry.file && fresh[entry.env]) : undefined;
        const pinned =
            home && signin && session.accountId && !session.useMachineLogin
                ? {
                      bytes: Buffer.from(fresh[signin.env]!, "base64"),
                      dir: accountHomes.accountHomeDir(commands.AGENT_HOME, cli.id, session.accountId)
                  }
                : null;
        if (pinned && home) env[home.env] = pinned.dir;
        const cleared = [
            ...cli.credentials.map((entry) => entry.env),
            ANTHROPIC_HEADERS_ENV,
            ...accountHomes.accountHomeEnvs()
        ];
        const body = commands.credentialsFileBody(cleared, guardEnv(env));
        const part = `credentials.${randomBytes(8).toString("hex")}.part`;
        if (placement.place === "host") {
            const result = await runInSession(
                sessionId,
                commands.writeCredentialsCommand(stateDir, part, body)
            );
            if (result.code !== 0) throw new Error(`the server answered ${result.code}`);
            return;
        }
        const containerId = placement.containerId;
        if (!containerId) return;
        await withContainerPorts(placement.hostId, async (ports) => {
            // A daemon too old to write a file keeps the boot's credentials.
            if (!ports.writeFile) return;
            if (pinned && session.accountId) {
                const signinPart = `account.${randomBytes(8).toString("hex")}.part`;
                await ports.writeFile(
                    containerId,
                    `${stateDir}/${signinPart}`,
                    Readable.from([pinned.bytes]),
                    pinned.bytes.length
                );
                const prepared = await ports.runIn(
                    containerId,
                    commands.shellArgv(
                        accountHomes.accountHomeCommand({
                            cliId: cli.id,
                            userHome: commands.AGENT_HOME,
                            accountId: session.accountId,
                            stateDir,
                            part: signinPart,
                            digest: accountHomes.storedDigest(pinned.bytes)
                        })
                    )
                );
                if (prepared.code !== 0) throw new Error(`the container answered ${prepared.code}`);
            }
            const bytes = Buffer.from(body, "utf8");
            await ports.writeFile(
                containerId,
                `${stateDir}/${part}`,
                Readable.from([bytes]),
                bytes.length
            );
            const placed = await ports.runIn(
                containerId,
                commands.shellArgv(commands.installCredentialsCommand(stateDir, part))
            );
            if (placed.code !== 0) throw new Error(`the container answered ${placed.code}`);
        });
    } catch (error) {
        console.error(
            `[agent-session] ${sessionId}: kept the credentials it booted with:`,
            error instanceof Error ? error.message : "unknown"
        );
    }
}

/**
 * The provider, model and key a multi-provider tool was started with, as the
 * variables it reads. Resolved again at every boot through the same order a
 * chat uses (the person's own key, then the deployment's where it shares them,
 * narrowed by who pays), so a key removed since is not one a reopened session
 * keeps spending. Nothing for a session that picked no model.
 */
async function modelEnvFor(session: SessionView): Promise<Record<string, string>> {
    const choice = session.modelChoice;
    if (!choice) return {};
    // A tool that signs in its own way and only needs to be told the model:
    // the variable its documentation names, and nothing about keys.
    if (core.agentCliById(session.cli)?.model?.env) return core.agentModelEnv(session.cli, choice.model);
    if (!core.MODEL_CHOICE_AGENT_CLIS.includes(session.cli)) return {};
    const credential = session.ownerId
        ? await chatCredentialFor(session.ownerId, choice.provider, choice.payer)
        : null;
    if (!credential) {
        throw new SessionRefusal(
            "There is no usable key for the provider this session was started with. Add one under AI keys, or start it on another model."
        );
    }
    return opencodeModelEnv({
        provider: choice.provider,
        model: choice.model,
        secret: credential.secret,
        baseUrl: credential.baseUrl,
        gatewayModel: credential.gatewayModel
    });
}

/**
 * Write a prompt's files into the session's working directory, each slice
 * insisted on, so a prompt never names a file that did not arrive.
 */
export async function placeAttachments(
    session: SessionView,
    userId: string,
    files: readonly attachments.SessionAttachment[]
): Promise<void> {
    if (files.length === 0) return;
    const bytes = await attachments.attachmentBytes(userId, files);
    // Where this session actually checked out: one started before checkouts
    // moved to a path per repository is still where it began.
    const workdir = (await sessionPlacement(session.id))?.workdir || workdirFor(session);
    for (const command of attachments.attachmentCommands(workdir, bytes)) {
        await steer(session.id, command, "The attached files did not reach the session");
    }
}

/**
 * The token the boot script clones with: one repository, read only, minted from
 * the installation on that repository's own owner.
 *
 * Refused rather than guessed. An owner the App is not installed on used to get
 * the FIRST installation's token - somebody else's account. A repository the
 * installation does not reach is GitHub refusing the scope (422), which only an
 * administrator can change; anything else GitHub or the network answers is
 * worth trying again rather than reconfiguring.
 */
async function cloneToken(repoFullName: string): Promise<string> {
    const scoped = scoping.repositoryScope(repoFullName, scoping.CLONE_PERMISSIONS);
    if (!scoped)
        throw new SessionRefusal(
            `Polaris cannot read ${repoFullName} as a GitHub repository name.`
        );
    let token: string | null;
    try {
        token = await githubAppInstallationToken(scoped.owner, scoped.scope);
    } catch (error) {
        console.error(`[agent-session] scoped token for ${repoFullName}:`, error);
        if (error instanceof GitHubStatusError && error.status === 422) {
            throw new SessionRefusal(
                `The GitHub App installed on ${scoped.owner} does not reach ${repoFullName}. The administrators have to add it to the installation.`
            );
        }
        throw new SessionRefusal(
            `GitHub did not hand Polaris a token for ${repoFullName}. Try again in a moment.`
        );
    }
    if (!token) {
        throw new SessionRefusal(
            `Polaris has no GitHub App installation for ${scoped.owner}. An administrator connects one under Integrations.`
        );
    }
    return token;
}

/** The repository's setup script and whether it may fail. Null for a repository
 *  that is gone, which runs nothing rather than refusing the session. */
/**
 * The repository's own agents (`.polaris/agents`, OpenCode's format) as the
 * files Claude Code and OpenCode read in a checkout, encoded for the boot
 * environment. Empty for a workspace, a repository with none, or when GitHub
 * does not answer: the session starts either way.
 */
export async function repoAgentFilesFor(
    session: Pick<SessionView, "repoFullName" | "baseRef">,
    token: string
): Promise<string> {
    const [owner, name] = session.repoFullName.split("/");
    if (!owner || !name) return "";
    const files = await repoAgentFiles({ owner, name, token: token || null }, session.baseRef || null, [
        ".polaris/agents"
    ]).catch(() => []);
    const rendered = sessionAgentFiles(files);
    return Object.keys(rendered).length > 0 ? asFile(JSON.stringify(rendered)) : "";
}

/** The cues of the repository a session was started on. Empty for a workspace. */
async function repoCuesFor(sessionId: string): Promise<string> {
    const row = await prisma.agentSession
        .findUnique({ where: { id: sessionId }, select: { repo: { select: { cues: true } } } })
        .catch(() => null);
    return row?.repo?.cues ?? "";
}

async function repoSetupFor(
    repoId: string
): Promise<{ setupScript: string; setupRequired: boolean } | null> {
    return prisma.agentRepo.findUnique({
        where: { id: repoId },
        select: { setupScript: true, setupRequired: true }
    });
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
        POLARIS_WORKDIR: boot.workdir,
        POLARIS_STATE_DIR: boot.stateDir,
        POLARIS_AGENT_CONFIG: boot.agentConfig,
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
        POLARIS_AGENT_RESUME: boot.agentResume,
        POLARIS_AGENT_HEADLESS: boot.agentHeadless,
        POLARIS_AGENT_FORK: boot.agentFork,
        POLARIS_AGENT_HOOK_ARGS: boot.agentHookArgs,
        POLARIS_AGENT_HOOK_PROBE: boot.agentHookProbe,
        // Base64 like every other file here; the boot writes it to the path
        // named, which must be inside the state directory.
        POLARIS_AGENT_HOOK_FILE: boot.agentHookConfig ? asFile(boot.agentHookConfig.contents) : "",
        POLARIS_AGENT_HOOK_PATH: boot.agentHookConfig?.path ?? "",
        POLARIS_ENIGMA_SETUP: boot.enigmaSetup,
        POLARIS_ENIGMA_CONFIGURE: boot.enigmaConfigure,
        POLARIS_FIRST_RUN: boot.firstRun,
        POLARIS_HOOK_SCRIPT: asFile(boot.hookScript),
        POLARIS_HOOK_SETTINGS: asFile(boot.hookSettings),
        POLARIS_MEMORY_SYNC: boot.memorySync ? asFile(boot.memorySync) : "",
        POLARIS_SKILLS_SYNC: boot.skillsSync ? asFile(boot.skillsSync) : "",
        POLARIS_CREDENTIAL_FILES: boot.credentialFiles,
        POLARIS_MCP_CONFIG: asFile(boot.mcpConfig),
        POLARIS_MCP_TOOLS_CONFIG: asFile(boot.mcpToolsConfig),
        POLARIS_TOOLS_MCP: asFile(boot.toolsServer),
        POLARIS_BROWSER_MCP: boot.browserServer ? asFile(boot.browserServer) : "",
        POLARIS_GIT_CREDENTIAL: boot.gitCredential ? asFile(boot.gitCredential) : "",
        POLARIS_REPO_SETUP: boot.repoSetup,
        POLARIS_REPO_SETUP_REQUIRED: boot.repoSetupRequired ? "yes" : "",
        POLARIS_REPO_AGENTS: boot.repoAgents,
        POLARIS_AGENT_POLICY: boot.agentPolicy,
        POLARIS_AGENT_POLICY_PATH: boot.agentPolicyPath,
        // Told to the agent, so a framework that needs its base path can be
        // started under it (see PREVIEW_PROMPT).
        POLARIS_PREVIEW_BASE: boot.previewBase,
        ...boot.autonomyEnv,
        // The tool's own variable naming that file. Before the credentials, so
        // nothing Polaris sets for its hooks can take a credential's place.
        ...(boot.agentHookConfig ? { [boot.agentHookConfig.env]: boot.agentHookConfig.path } : {}),
        ...boot.credentials
    });
}

/**
 * The hook configuration of a session's own for a tool pointed at one through
 * a variable (`museSessionHooks`, `codewhaleSessionConfig`), at its path in
 * the state directory. Null for any other tool. Only where Polaris owns the
 * machine, which is also where the state directory is a fixed absolute path.
 */
export function sessionHookConfig(
    cliId: string,
    stateDir: string,
    { webhook }: { webhook: string }
): { path: string; env: string; contents: string } | null {
    const config =
        cliId === "muse"
            ? core.museSessionHooks(`${stateDir}/hook.sh`)
            : cliId === "codewhale"
              ? core.codewhaleSessionConfig(`${stateDir}/codewhale-lifecycle.jsonl`, webhook)
              : null;
    return config ? { path: `${stateDir}/${config.name}`, env: config.env, contents: config.contents } : null;
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
        if (core.hasControlCharacter(value)) {
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
        if (session.place === "computer") {
            await computer.startOnComputer(session, token);
            await markSessionStarted(session.id, "", "");
            return;
        }
        const boot = await bootstrapFor(session, token);
        if (session.place === "host") {
            await startOnHost(session, boot);
            await markSessionStarted(session.id, "", boot.workdir);
        } else {
            await startPlaced(session, boot);
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

/**
 * Place a container session on the pool and bring it up there.
 *
 * A server that will not take it (unreachable, its engine refusing) is left
 * out and the session is placed once more, on another server or this box,
 * rather than failed: one machine going away must not fail the sessions that
 * happened to be sent to it. A refusal Polaris wrote itself is not retried -
 * it would say the same thing anywhere.
 */
async function startPlaced(session: SessionView, boot: Bootstrap): Promise<void> {
    const box = await totalCeiling();
    const place = async (current: SessionView, exclude: string[]) => {
        try {
            return await placement.placeSession(current, box, exclude);
        } catch (error) {
            if (error instanceof placement.PoolFull) {
                throw new SessionRefusal(
                    "Every server Polar Code may use is full right now. Try again when a session finishes."
                );
            }
            throw error;
        }
    };
    const hostId = await place(session, []);
    try {
        await startLocally({ ...session, hostId }, boot);
    } catch (error) {
        if (!hostId || error instanceof SessionRefusal) throw error;
        console.error(`[agent-session] ${session.id}: server ${hostId} refused it, placing again:`, error);
        // Whatever it got as far as starting there - a spare, half a container -
        // goes, so nothing is left running under a name the session no longer
        // points at. Best effort: a server that refused may not answer this either.
        await withContainerPorts(hostId, (ports) =>
            ports.composeDown(commands.sessionContainerName(session.id))
        ).catch(() => undefined);
        const next = await place({ ...session, hostId: null }, [hostId]);
        await startLocally({ ...session, hostId: next }, boot);
    }
}

async function startLocally(session: SessionView, boot: Bootstrap): Promise<void> {
    const env = bootEnv(boot);
    // A spare started while the message was typed already runs under this
    // session's name, past the slow part of a boot. See `session-spares`.
    if (await claimSpare(session, env)) return;
    await startContainer(session, env, commands.SESSION_BOOT);
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
            commands.hostSessionScope(session.id, true),
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
export async function runInSession(
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
    // A computer's runner takes protocol frames, not shell commands. Callers
    // that reach here for one treat it like any machine that did not answer.
    if (placement.place === "computer") throw new Error("That session runs on a computer, which takes no commands.");

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
                // Its own tmux server and temporary directory. See `hostSessionScope`.
                input: `${commands.hostSessionScope(sessionId)}\n${command}`,
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
    const containerId = placement.containerId;
    const result = await withContainerPorts(placement.hostId, (ports) =>
        ports.runIn(containerId, commands.shellArgv(command))
    );
    return { code: result.code, output: result.output };
}

/**
 * Whether the boot left the custom tools' server out of a session because its
 * machine had no `node` to run it with (see PREPARE_WORKTREE). False for a
 * computer's session, which never gets the server, and wherever the machine
 * cannot be asked: the tools screen only explains a skip it can see.
 */
export async function toolsServerSkipped(
    sessionId: string,
    run: typeof runInSession = runInSession
): Promise<boolean> {
    const placement = await sessionPlacement(sessionId);
    if (!placement || placement.place === "computer") return false;
    const marker = `${stateDirFor({ id: sessionId, place: placement.place })}/${toolsMcp.TOOLS_NO_NODE_FILE}`;
    const result = await run(sessionId, `if [ -f "${marker}" ]; then echo skipped; fi`).catch(() => null);
    return (result?.output ?? "").split("\n").some((line) => line.trim() === "skipped");
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
/** How often the first prompt asks whether the agent is up. Each ask is one
 *  short command; at 5 s the prompt sat for up to 5 s after the agent was ready. */
const AGENT_READY_POLL_MS = 1000;

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
        const ready = await runInSession(
            sessionId,
            `${commands.runnerReadyCommand(stateDirFor(placement))} || { ${commands.agentReadyCommand()}; }`
        ).catch(() => null);
        if (ready?.code === 0) return true;
        if (Date.now() + AGENT_READY_POLL_MS >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, AGENT_READY_POLL_MS));
    }
}

/** What a computer's runner said to a capture, in the scripts' words. */
function computerCapture(answer: core.SnapshotAnswer | null): snapshots.CaptureResult | null {
    switch (answer?.kind) {
        case "captured":
            return { kind: "captured", id: answer.id };
        case "kept":
            return { kind: "kept", id: answer.id, undoneLabel: answer.undoneLabel };
        case "nocheckout":
        case "failed":
            return { kind: answer.kind };
        default:
            return null;
    }
}

/** Take a turn's snapshot where the session runs: its container or server
 *  through the script, a computer through its runner (only one that keeps
 *  snapshots; an older desktop is skipped). Never longer than
 *  `CAPTURE_TIMEOUT_S`; null when it said nothing in time. */
async function captureTurn(
    sessionId: string,
    placement: { place: core.AgentSessionPlace; workdir: string },
    text: string
): Promise<snapshots.CaptureResult | null> {
    const capture = (async () => {
        if (placement.place !== "computer")
            return snapshots.parseCapture((await runInSession(sessionId, snapshots.captureScript({ workdir: placement.workdir, prompt: text }))).output);
        const runnerId = await computerSessionRunner(sessionId);
        if (!runnerId) return null;
        const label = text.replace(/\s+/g, " ").trim().slice(0, core.SNAPSHOT_LIMITS.labelChars);
        return computerCapture(await runComputerSnapshot({ id: sessionId, runnerId }, { kind: "capture", label }));
    })().catch((error: unknown) => {
        console.error(`polaris: could not snapshot session ${sessionId} before a turn:`, error);
        return null;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), snapshots.CAPTURE_TIMEOUT_S * 1000);
    });
    return Promise.race([capture, late]).finally(() => clearTimeout(timer));
}

/**
 * Snapshot the checkout before a turn (`session-snapshots.ts`), so the turn can
 * be undone, and hand back the prompt to send. When an undo was in progress the
 * snapshot keeps it, and the agent is told which message was undone: its own
 * conversation cannot be cut from here. Never holds a prompt longer than
 * `CAPTURE_TIMEOUT_S`, and a snapshot that fails only loses the undo point.
 */
async function snapshotBeforeTurn(
    sessionId: string,
    placement: { place: core.AgentSessionPlace; workdir: string },
    text: string
): Promise<string> {
    const said = await captureTurn(sessionId, placement, text);
    return said?.kind === "kept" ? `${snapshots.undoneNote(said.undoneLabel)}

${text}` : text;
}

/**
 * Snapshot the checkout for a prompt somebody typed straight into the session's
 * terminal, which Polaris hears of only from the agent's prompt hook. Taken as
 * soon as the hook reports it, so the agent may already have begun; a prompt
 * Polaris sent itself was snapshotted before it went, and the script takes the
 * same files moments later as that same turn.
 */
export async function snapshotTypedPrompt(sessionId: string, text: string): Promise<void> {
    const placement = await sessionPlacement(sessionId).catch(() => null);
    if (!placement || core.isSessionOver(placement.state)) return;
    await captureTurn(sessionId, placement, text);
}

/**
 * Send a session something to work on.
 *
 * Two calls with a wait between them, and the wait is the point: the paste has to
 * have reached the agent before the newline that submits it means anything, and
 * sending both at once sends half a prompt. The text is recorded as a message
 * first, so what somebody asked for survives even if the machine has gone away.
 */
export async function promptSession(
    sessionId: string,
    text: string,
    options: { fromChat?: boolean } = {}
): Promise<void> {
    // Before the prompt is queued, so the turn it starts reads the credentials
    // as they are now rather than as they were when the machine booted.
    // The placement is read alongside, rather than after, so a turn waits on one
    // round trip of reads instead of two.
    const [, stored] = await Promise.all([
        refreshCredentials(sessionId),
        sessionPlacement(sessionId)
    ]);
    // A session whose runner takes its prompts gets this one as a file in the
    // queue: nothing typed, nothing that has to look ready first.
    if (!stored) throw new Error("That session no longer exists.");
    const placement = await reconcileTerminalBack(sessionId, stored);
    if (placement.place === "computer")
        return computer.promptOnComputer(sessionId, await snapshotBeforeTurn(sessionId, placement, text));
    const sent = await snapshotBeforeTurn(sessionId, placement, text);
    if (options.fromChat && (await remoteTurn(sessionId, placement, sent))) return;
    if (acpProviders.usesAcp(placement)) return acpPrompt(sessionId, placement.cli, sent);
    const queued = await runInSession(
        sessionId,
        commands.queuePromptCommand(stateDirFor(placement), sent)
    ).catch(() => null);
    if (queued?.code === 0) return;
    // The interface is open beside the runner: the prompt goes to it, typed.
    const target =
        queued?.code === commands.NOT_QUEUED.interfaceOpen
            ? `${commands.TMUX_SESSION}:${commands.INTERFACE_WINDOW}`
            : commands.TMUX_SESSION;
    if (queued && queued.code !== commands.NOT_QUEUED.interactive && target === commands.TMUX_SESSION)
        throw new Error("The agent's machine did not take the prompt");
    await steer(sessionId, commands.pastePromptCommand(sent, target), "The agent's terminal did not take the prompt");
    await new Promise((resolve) => setTimeout(resolve, commands.submitDelayMs(sent)));
    await steer(sessionId, commands.submitCommand(target), "The prompt was pasted but not submitted");
}

/**
 * Send a turn again through the runner's queue only, after its credentials
 * were moved to another account. Never typed: an agent process already running
 * in the terminal keeps the variables it started with, so typing the turn into
 * it would meet the same limit and move the session through every account.
 * False when the session has no runner taking prompts, or its interface is
 * open; the turn then waits for the person.
 */
export async function queueTurnAgain(sessionId: string, text: string): Promise<boolean> {
    const [, placement] = await Promise.all([refreshCredentials(sessionId), sessionPlacement(sessionId)]);
    if (!placement) return false;
    const queued = await runInSession(
        sessionId,
        commands.queuePromptCommand(stateDirFor(placement), text)
    ).catch(() => null);
    return queued?.code === 0;
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
export async function deliverFirstPrompt(
    sessionId: string,
    text: string,
    files: {
        session: SessionView;
        userId: string;
        files: readonly attachments.SessionAttachment[];
    } | null = null
): Promise<void> {
    try {
        if (!(await waitForAgent(sessionId))) {
            throw new Error("its agent never opened a terminal to type into");
        }
        // Once the agent is up, the checkout is there to write into.
        if (files) await placeAttachments(files.session, files.userId, files.files);
        await promptSession(sessionId, withCues(await repoCuesFor(sessionId), text));
    } catch (error) {
        await addSessionMessage(
            sessionId,
            "system",
            `Polaris could not send the first prompt: ${error instanceof Error ? error.message : "unknown"}. Send it again from the box below.`
        ).catch(() => undefined);
    }
}

/**
 * The first prompt of a session that took over from another agent, or carries
 * on a stopped one: the whole conversation is written into the working
 * directory first (`session-handoff`), then the note naming it is sent. A file
 * that does not arrive leaves the note to stand alone, said on the session.
 */
export async function deliverHandoff(
    session: SessionView,
    note: string,
    file: { path: string; text: string }
): Promise<void> {
    try {
        if (!(await waitForAgent(session.id))) {
            throw new Error("its agent never opened a terminal to type into");
        }
        try {
            const workdir = (await sessionPlacement(session.id))?.workdir || workdirFor(session);
            const bytes = new TextEncoder().encode(file.text);
            for (const command of attachments.attachmentCommands(workdir, [{ path: file.path, bytes }])) {
                await steer(session.id, command, "The conversation file did not reach the session");
            }
        } catch (error) {
            console.error(`[agent-session] ${session.id}: conversation file not written:`, error instanceof Error ? error.message : "unknown");
            await addSessionMessage(
                session.id,
                "system",
                "Polaris could not write the earlier conversation into this session. The agent was given a summary of it."
            ).catch(() => undefined);
        }
        await promptSession(session.id, note);
    } catch (error) {
        await addSessionMessage(
            session.id,
            "system",
            `Polaris could not send the earlier conversation: ${error instanceof Error ? error.message : "unknown"}. Tell the agent where things stand from the box below.`
        ).catch(() => undefined);
    }
}

/**
 * Change a running session's permission mode, as its picker does mid-session.
 * Only for a tool that takes one; `from` is the mode it last reported.
 */
export async function changeSessionMode(
    sessionId: string,
    cliId: string,
    from: core.SessionPermissionMode | null,
    to: core.SessionPermissionMode
): Promise<void> {
    const args = core.permissionModeArgs(cliId, to);
    const placement = await reconcileTerminalBack(sessionId, await sessionPlacement(sessionId));
    if (placement?.place === "computer") return computer.settingsOnComputer(sessionId, { permissionMode: to });
    if (placement && acpProviders.usesAcp(placement))
        return acpCall(() => acpDrivers.acpDriver(sessionId, placement.cli).setMode(to));
    if (!args || !placement) throw new Error("That session no longer exists.");
    await steer(
        sessionId,
        commands.permissionModeCommand(stateDirFor(placement), args[1]!, commands.modePresses(from, to)),
        "The agent's terminal did not take the mode"
    );
}

/**
 * Change a running Claude session's model, as the thread's picker does
 * mid-session: for its next turn, or at once in an open interface.
 */
export async function changeSessionModel(sessionId: string, model: string): Promise<void> {
    const placement = await sessionPlacement(sessionId);
    if (!placement) throw new Error("That session no longer exists.");
    if (placement.place === "computer") return computer.settingsOnComputer(sessionId, { model });
    await steer(
        sessionId,
        commands.modelCommand(stateDirFor(placement), model),
        "The agent's terminal did not take the model"
    );
}

/**
 * Change how hard a running session thinks: for its next turn, or at once in
 * an open interface. Only for a tool with an effort command.
 */
export async function changeSessionEffort(
    sessionId: string,
    cliId: string,
    level: core.AgentEffortLevel
): Promise<void> {
    const support = core.agentCliById(cliId)?.effort;
    if (!support || !support.levels.includes(level)) throw new Error("That tool takes no effort level.");
    const placement = await sessionPlacement(sessionId);
    if (!placement) throw new Error("That session no longer exists.");
    if (placement.place === "computer") return computer.settingsOnComputer(sessionId, { effort: level });
    await steer(
        sessionId,
        commands.effortCommand(stateDirFor(placement), support.command, level),
        "The agent's terminal did not take the effort"
    );
}

/** Stop what the agent is doing without ending the session. */
export async function interruptSession(sessionId: string): Promise<void> {
    const placement = await reconcileTerminalBack(sessionId, await sessionPlacement(sessionId));
    if (placement?.place === "computer") return computer.interruptOnComputer(sessionId);
    if (placement && acpProviders.usesAcp(placement))
        return acpCall(() => acpDrivers.acpDriver(sessionId, placement.cli).cancel());
    if (placement) {
        const stopped = await runInSession(
            sessionId,
            commands.interruptTurnCommand(stateDirFor(placement))
        ).catch(() => null);
        if (stopped?.code === 0) return;
    }
    await steer(
        sessionId,
        commands.interruptCommand(),
        "The agent's terminal did not take the interrupt"
    );
}

/**
 * Whether the session's agent has exited and left its window at the shell.
 *
 * A machine that does not answer is "no": the button this feeds types into the
 * terminal, and typing on a guess is how a launch line ends up as a prompt.
 */
export async function agentHasExited(sessionId: string): Promise<boolean> {
    const placement = await sessionPlacement(sessionId);
    if (!placement) return false;
    const result = await runInSession(
        sessionId,
        commands.agentExitedCommand(commands.TMUX_SESSION, stateDirFor(placement))
    ).catch(() => null);
    return result?.code === 0;
}

/**
 * Open the agent's own interface beside the runner, on the same conversation.
 * "interactive" for a session whose terminal already is the interface, "busy"
 * while a turn is running.
 */
export async function openAgentInterface(
    sessionId: string
): Promise<"opened" | "interactive" | "busy"> {
    const placement = await sessionPlacement(sessionId);
    if (!placement) throw new Error("That session no longer exists.");
    await refreshCredentials(sessionId);
    const result = await runInSession(sessionId, commands.openInterfaceCommand(stateDirFor(placement)));
    if (result.code === 0) return "opened";
    if (result.code === commands.NOT_OPENED.interactive) return "interactive";
    if (result.code === commands.NOT_OPENED.turnRunning) return "busy";
    throw new Error("The session's terminal did not open the agent's interface");
}

/**
 * Start the session's agent in protocol mode: `argv` (a provider binding's
 * launch line) in its own window, its input and output on the pipe
 * `acp/pipe-commands` describes. Starting again replaces the agent that was
 * there, and a connection still open on the old one ends (`PipeClosedError`).
 */
export async function startAcpAgent(sessionId: string, argv: readonly string[]): Promise<void> {
    const placement = await sessionPlacement(sessionId);
    if (!placement) throw new Error("That session no longer exists.");
    await refreshCredentials(sessionId);
    const stateDir = stateDirFor(placement);
    // In Chat the terminal holds no agent of its own: one a boot or a resume
    // started there would work the same checkout as this one. Unless the
    // terminal took the session back since whoever asked for this looked:
    // then the agent there is the person's, and nothing starts.
    const launched = await runInSession(
        sessionId,
        acpPipe.acpLaunchCommand(stateDir, argv, commands.TMUX_SESSION, acpPipe.terminalAgentStopCommand(stateDir))
    );
    if (launched.code === acpPipe.ACP_TERMINAL_BACK) throw new AcpRefusal(TERMINAL_HAS_IT);
    if (launched.code === 0) return;
    const said = launched.output.trim().slice(-300);
    const whatFor = "The session's machine did not start the agent";
    throw new Error(said ? `${whatFor}: ${said}` : whatFor);
}

/** What `reconcileTerminalBack` reads of a placement. */
interface TerminalBackPlacement {
    id: string;
    place: core.AgentSessionPlace;
    cli: string;
    surface: acpProviders.SessionSurface;
}

/** Why Chat did not start: the terminal has the session. */
const TERMINAL_HAS_IT = "The terminal took this session back. Send it again to reach it there.";

/**
 * Bring the stored surface up to what the session's terminal did: when its
 * waiting script took the session back from Chat on a key (`acp/handoff.ts`),
 * the Chat driver is closed, the session is recorded in Terminal and the page
 * is told. Returns the placement as it now stands, so the caller acts on the
 * terminal instead of on Chat. Called before anything that reaches the Chat
 * driver, and by the hook the script reports with; a machine that does not
 * answer leaves the record as it was.
 */
export async function reconcileTerminalBack<T extends TerminalBackPlacement | null>(
    sessionId: string,
    placement: T
): Promise<T> {
    if (!placement || placement.surface !== "chat" || !handoff.handsOff(placement.cli, placement.place))
        return placement;
    const back = await runInSession(sessionId, handoff.terminalBackCommand(stateDirFor(placement))).catch(() => null);
    if (back?.output.trim() !== handoff.TERMINAL_BACK) return placement;
    // The waiting script already stopped Chat's agent and resumed the
    // conversation in the terminal; only the record is behind.
    acpDrivers.closeAcpDriver(sessionId);
    await prisma.agentSession.update({ where: { id: sessionId }, data: { surface: "terminal" }, select: { id: true } });
    touchSession(sessionId);
    return { ...placement, surface: "terminal" } as T;
}

/**
 * A prompt in Chat; see `acp/session-driver` and `codex/session-driver`. A
 * Codex too old to have an app-server sends the session back to its terminal,
 * the way it ran before Chat, and the message goes there instead of failing.
 */
async function acpPrompt(sessionId: string, cli: string, text: string): Promise<void> {
    try {
        return await acpCall(() => acpDrivers.acpDriver(sessionId, cli).prompt(text));
    } catch (error) {
        if (!(error instanceof CodexAppServerMissing)) throw error;
        console.error(`[agent-session] ${sessionId}: this Codex has no app-server, back to the terminal`);
        await switchSessionSurface(sessionId, "terminal");
        return promptSession(sessionId, text);
    }
}

/** Sessions whose Chat would not start lately, and when, in this process. */
const chatFailures = new Map<string, number>();

/**
 * A message from Polar Code to a session that can be answered in Chat
 * (`acp/handoff.ts`): a Terminal session that is idle hands its conversation
 * to Chat first, so the answer streams; one the terminal took back since the
 * last message is put back in Terminal before that is decided. True when the
 * message was sent; false leaves it to the terminal, as before. A Chat that
 * will not start here (no npx, no network, an adapter that exits) is logged
 * and the message goes to the terminal instead, with nothing shown.
 */
async function remoteTurn(
    sessionId: string,
    placement: NonNullable<Awaited<ReturnType<typeof sessionPlacement>>>,
    text: string
): Promise<boolean> {
    if (!handoff.handsOff(placement.cli, placement.place)) return false;
    const surface = placement.surface;
    const row = await prisma.agentSession.findUnique({ where: { id: sessionId }, select: { vendorSessionId: true } });
    const failedAt = chatFailures.get(sessionId);
    const route = handoff.remoteTurnRoute({
        cli: placement.cli,
        place: placement.place,
        surface,
        state: placement.state,
        vendorSessionId: row?.vendorSessionId ?? null,
        chatFailedRecently: failedAt !== undefined && Date.now() - failedAt < handoff.CHAT_RETRY_MS
    });
    if (route === "terminal") return false;
    if (route === "hand-off") {
        try {
            await switchSessionSurface(sessionId, "chat");
        } catch (error) {
            console.error(`[agent-session] ${sessionId}: the terminal did not hand over to Chat`, error);
            return false;
        }
    }
    try {
        await acpDrivers.acpDriver(sessionId, placement.cli).prompt(text);
        chatFailures.delete(sessionId);
        return true;
    } catch (error) {
        // A turn still running in Chat is the person's to wait for or stop.
        if (route === "chat" && error instanceof AcpRefusal && acpDrivers.acpDriver(sessionId, placement.cli).busy)
            throw new SessionRefusal(error.message);
        // A key in the terminal between the check and the launch: nothing is
        // wrong with Chat, the terminal simply has the session.
        if (!(error instanceof AcpRefusal && error.message === TERMINAL_HAS_IT)) {
            console.error(`[agent-session] ${sessionId}: Chat did not start here, the terminal answers instead`, error);
            chatFailures.set(sessionId, Date.now());
        }
        await switchSessionSurface(sessionId, "terminal").catch((caught: unknown) =>
            console.error(`[agent-session] ${sessionId}: the terminal did not take the session back`, caught)
        );
        // The terminal is resuming the conversation; the message waits for it.
        if (await promptMovedAgent(sessionId, text)) return true;
        throw new Error("The agent's terminal did not take the prompt");
    }
}

/** An ACP call whose refusal is a sentence for the person, and whose other
 *  failures (the agent's own words, a machine's) stay in the log. */
async function acpCall(work: () => Promise<void>): Promise<void> {
    try {
        await work();
    } catch (error) {
        if (error instanceof AcpRefusal) throw new SessionRefusal(error.message);
        throw error;
    }
}

/**
 * Hold the session's conversation in its terminal or in Chat. Leaving Chat
 * closes the connection and takes the protocol agent's window down; entering
 * it starts nothing until the next message, which starts the agent and reopens
 * its conversation.
 */
export async function switchSessionSurface(
    sessionId: string,
    surface: acpProviders.SessionSurface
): Promise<void> {
    const placement = await reconcileTerminalBack(sessionId, await sessionPlacement(sessionId));
    if (!placement) throw new Error("That session no longer exists.");
    if (surface === "chat" && !acpProviders.chatAvailable(placement.cli, placement.place))
        throw new SessionRefusal("This agent cannot be used in Chat here.");
    const stateDir = stateDirFor(placement);
    const moving = placement.surface !== surface;
    // Two agents in one checkout would write over each other's work, so the
    // terminal's goes first; a machine that does not answer keeps the session
    // where it was.
    // Into Chat the last hand-back is forgotten first, or the launch would
    // refuse as though the terminal had just taken it back.
    if (surface === "chat" && moving)
        await steer(
            sessionId,
            `${handoff.chatEntryCommand(stateDir)}\n${acpPipe.terminalAgentStopCommand(stateDir)}`,
            "The agent in the session's terminal did not stop"
        );
    if (surface === "chat" && moving && handoff.handsOff(placement.cli, placement.place))
        await holdTerminal(sessionId, stateDir);
    if (surface === "terminal") {
        acpDrivers.closeAcpDriver(sessionId);
        if (moving) await runInSession(sessionId, handoff.chatHoldStopCommand()).catch(() => undefined);
        await runInSession(sessionId, acpPipe.acpStopCommand(stateDir)).catch(() => undefined);
    }
    await prisma.agentSession.update({ where: { id: sessionId }, data: { surface }, select: { id: true } });
    touchSession(sessionId);
    if (surface === "terminal" && moving) await handConversationBack(sessionId, stateDir);
}

/**
 * Into Chat: the terminal's window waits for a key to take the conversation
 * back (`acp/handoff.ts`). Best effort - without it the window is left at its
 * shell, as a switch always left it, and Terminal is one click away.
 */
async function holdTerminal(sessionId: string, stateDir: string): Promise<void> {
    const row = await prisma.agentSession.findUnique({ where: { id: sessionId }, select: { vendorSessionId: true } });
    const id = row?.vendorSessionId;
    if (!id || !core.isVendorSessionId(id)) return;
    try {
        await steer(sessionId, handoff.chatHoldCommand(stateDir, id), "The terminal did not wait for Chat");
    } catch (error) {
        console.error(`[agent-session] ${sessionId}: the terminal will not take the conversation back by itself`, error);
    }
}

/** Record the conversation Chat is on where the terminal's waiting script
 *  reads it. Best effort, like the script. */
export async function noteChatConversation(sessionId: string, vendorSessionId: string): Promise<void> {
    const placement = await sessionPlacement(sessionId);
    if (!placement || !handoff.handsOff(placement.cli, placement.place)) return;
    await runInSession(sessionId, handoff.chatConversationCommand(stateDirFor(placement), vendorSessionId)).catch(
        () => undefined
    );
}

/**
 * Back from Chat: the terminal carries on with the conversation Chat was on.
 * A runner's next turn reads its id; an interactive terminal, left at its
 * shell when Chat began, gets the agent typed back in on it. Best effort - the
 * switch has happened either way, and Resume is still there.
 */
async function handConversationBack(sessionId: string, stateDir: string): Promise<void> {
    const row = await prisma.agentSession.findUnique({ where: { id: sessionId }, select: { vendorSessionId: true } });
    const id = row?.vendorSessionId;
    if (!id || !core.isVendorSessionId(id)) return;
    try {
        const handed = await runInSession(sessionId, acpPipe.conversationHandBackCommand(stateDir, id));
        if (handed.code !== acpPipe.HAND_BACK_INTERACTIVE) return;
        if (await agentHasExited(sessionId)) await resumeAgent(sessionId, id);
    } catch (error) {
        console.error(`[agent-session] ${sessionId}: the terminal did not take the conversation back`, error);
    }
}

/** The session's protocol pipe, for `acp/transport`'s `pipeStream`. */
export async function sessionAcpPipe(sessionId: string): Promise<acpTransport.PipeIo> {
    const placement = await sessionPlacement(sessionId);
    if (!placement) throw new Error("That session no longer exists.");
    return acpTransport.shellPipe(stateDirFor(placement), (command) => runInSession(sessionId, command));
}

/** Bring the agent back on its conversation, typed into the shell it left. */
export async function resumeAgent(sessionId: string, vendorSessionId: string): Promise<void> {
    await refreshCredentials(sessionId);
    await steer(
        sessionId,
        commands.resumeCommand(vendorSessionId),
        "The session's terminal did not take the resume"
    );
    await steer(sessionId, commands.submitCommand(), "The resume was typed but not submitted");
}

/** What became of the agent when its session moved to another account. */
export type AgentMove = "next-turn" | "resumed" | "relaunched" | "stays";

/**
 * Put a running session's agent on the account its session now names.
 *
 * The credentials file is written first, which is all a runner session needs:
 * every turn starts afresh and reads it ("next-turn"). An agent that left its
 * terminal is brought back on its conversation ("resumed"). One running in its
 * own interface keeps the variables it started with, so its turn is ended
 * with Esc and it is restarted on the same conversation ("relaunched"), the way
 * the rotation resumes a Claude session. "stays" when there is no conversation
 * to come back to, which leaves the agent as it is rather than starting a new
 * one over it.
 */
export async function moveAgentToAccount(sessionId: string): Promise<AgentMove> {
    const [, placement, row] = await Promise.all([
        refreshCredentials(sessionId),
        sessionPlacement(sessionId),
        prisma.agentSession.findUnique({ where: { id: sessionId }, select: { cli: true, vendorSessionId: true } })
    ]);
    if (!placement || !row) return "stays";
    const conversation =
        core.agentResumeStyle(row.cli) !== "" && row.vendorSessionId && core.isVendorSessionId(row.vendorSessionId)
            ? row.vendorSessionId
            : null;
    if (!conversation) return "stays";
    if (await agentHasExited(sessionId)) {
        await steer(sessionId, commands.clearReadyCommand(), "The session's terminal did not take the resume");
        await steer(sessionId, commands.resumeCommand(conversation), "The session's terminal did not take the resume");
        await steer(sessionId, commands.submitCommand(), "The resume was typed but not submitted");
        return "resumed";
    }
    const result = await runInSession(sessionId, commands.relaunchAgentCommand(stateDirFor(placement), conversation));
    if (result.code === commands.NOT_RELAUNCHED.nextTurn) return "next-turn";
    if (result.code !== 0) throw new Error("The session's terminal did not restart the agent");
    return "relaunched";
}

/** How long a restarted agent is given to hold its terminal again before a
 *  turn is typed into it: a resume reads the whole conversation back. */
const RELAUNCH_READY_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Type a turn into an agent `moveAgentToAccount` restarted or resumed, once it
 * holds its terminal again. False when it never did in time; the turn is then
 * the person's to send.
 */
export async function promptMovedAgent(sessionId: string, text: string): Promise<boolean> {
    const placement = await sessionPlacement(sessionId);
    if (!placement) return false;
    const probe = commands.movedAgentReadyCommand(stateDirFor(placement));
    const deadline = Date.now() + RELAUNCH_READY_TIMEOUT_MS;
    for (;;) {
        const ready = await runInSession(sessionId, probe).catch(() => null);
        if (ready?.code === 0) break;
        if (Date.now() + AGENT_READY_POLL_MS >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, AGENT_READY_POLL_MS));
    }
    await promptSession(sessionId, text);
    return true;
}

/** What the agent's terminal currently shows. */
export async function captureSession(sessionId: string, lines = 200): Promise<string> {
    const result = await runInSession(sessionId, commands.captureCommand(lines));
    return result.output;
}

/**
 * End a session and take its machine with it.
 *
 * The container goes, but only after its work is saved: anything committed or
 * left uncommitted is pushed to the session's branch first, and a container
 * whose work could not be pushed is kept rather than removed (see
 * `session-work.ts`). On a server the tmux session is killed and the worktree is
 * left where it is - a directory on somebody's own server is theirs to remove.
 *
 * Returns what became of the work, or null where there was no container.
 */
export async function stopSession(sessionId: string): Promise<SaveOutcome | null> {
    const placement = await sessionPlacement(sessionId);
    if (!placement) return null;
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
    acpDrivers.closeAcpDriver(sessionId);
    // Whoever pressed Stop has answered whatever it was waiting on.
    await clearSessionWaiting(sessionId);
    await syncFinalSessionHistory(sessionId);
    if (placement.place === "computer") {
        await computer.stopOnComputer(sessionId);
        return null;
    }
    if (placement.place === "host") {
        await runInSession(
            sessionId,
            `tmux kill-session -t ${shellQuote(commands.TMUX_SESSION)} || true`,
            { evenIfFinished: true }
        ).catch(() => undefined);
        return null;
    }
    if (!placement.containerId) return null;
    return endContainerSession(sessionId);
}

/**
 * Sessions whose machine has gone quiet for long enough to ask whether it is
 * still there.
 *
 * Silence is not death. A session waiting on a permission prompt, one that
 * finished its turn overnight, and every agent that reports nothing at all
 * (anything but Claude) are all silent by nature, and failing them after six
 * hours ended work somebody was coming back to. So silence only earns a probe:
 * the runtime's own `aliveCommand` asks whether the terminal is still there,
 * and only a session whose terminal is gone is failed. One that answers is
 * left alone and not asked again for another stretch. See `sweepVerdict`.
 *
 * A server session is asked after a much shorter stretch (`hostSilentMs`): a
 * restart of its server takes the terminal and leaves nothing else to notice,
 * and it is only reopened when it is asked. It is still failed no sooner than
 * any other session.
 */
export async function sweepSilentSessions(
    maxSilentMs = 6 * 60 * 60 * 1000,
    hostSilentMs = Math.min(maxSilentMs, 15 * 60 * 1000)
): Promise<number> {
    const now = new Date();
    const quietSince = (cutoff: Date) => [
        { OR: [{ lastEventAt: { lt: cutoff } }, { lastEventAt: null, createdAt: { lt: cutoff } }] },
        { OR: [{ lastAliveAt: null }, { lastAliveAt: { lt: cutoff } }] },
        { OR: [{ lastProbedAt: null }, { lastProbedAt: { lt: cutoff } }] }
    ];
    const quiet = await prisma.agentSession.findMany({
        where: {
            // A queued session has no machine to probe. It is the queue's.
            state: { notIn: ["stopped", "failed", "queued"] },
            OR: [
                {
                    place: { not: "host" },
                    AND: quietSince(new Date(now.getTime() - maxSilentMs))
                },
                { place: "host", AND: quietSince(new Date(now.getTime() - hostSilentMs)) }
            ]
        },
        select: {
            id: true,
            place: true,
            hostId: true,
            containerId: true,
            lastEventAt: true,
            createdAt: true
        },
        orderBy: { lastProbedAt: { sort: "asc", nulls: "first" } },
        take: 200
    });
    let failed = 0;
    for (const session of quiet) {
        let probe = await probeSession(
            session.id,
            session.place,
            session.containerId,
            session.hostId
        );
        // A server that restarted took the terminal with it but kept the
        // checkout, so the session is reopened on it rather than failed.
        if (probe === "dead" && session.place === "host" && (await reopenOnHost(session.id)))
            probe = "alive";
        const heard = session.lastEventAt ?? session.createdAt;
        const silentFor = now.getTime() - heard.getTime();
        const early = session.place === "host" && silentFor <= maxSilentMs;
        const verdict = early ? "keep" : core.sweepVerdict(probe, silentFor, maxSilentMs);
        if (verdict === "keep") {
            await prisma.agentSession.update({
                where: { id: session.id },
                data:
                    probe === "alive"
                        ? { lastAliveAt: now, lastProbedAt: now }
                        : { lastProbedAt: now }
            });
            continue;
        }
        failed += 1;
        await finishSession(
            session.id,
            "failed",
            probe === "gone"
                ? "The container running this session was deleted."
                : "The machine running this session stopped reporting."
        );
        await clearSessionWaiting(session.id);
        await noticeSessionEnded(session.id, "silent");
        if (probe !== "gone") await syncFinalSessionHistory(session.id);
        // The same path as Stop: the work is pushed before the container goes,
        // and a container whose work could not be pushed stays. Nothing to do
        // for one that is already gone.
        if (session.place !== "host" && session.containerId && probe !== "gone")
            await endContainerSession(session.id).catch((error) => {
                console.error(
                    `polaris: could not end the container of session ${session.id}:`,
                    error
                );
            });
    }
    return failed;
}

/**
 * Whether a session's terminal is still there: its tmux session answers, does
 * not, the machine could not be asked at all, or - for a container - the box
 * answered that there is no such container any more.
 *
 * A container that exists but is stopped is started again on the way: its boot
 * reopens on the checkout it kept, so the next probe finds it alive.
 */
async function probeSession(
    sessionId: string,
    place: string,
    containerId: string | null,
    hostId: string | null
): Promise<core.SessionProbe> {
    try {
        const result = await runInSession(sessionId, commands.aliveCommand());
        return result.code === 0 ? "alive" : "dead";
    } catch (error) {
        console.error(`[agent-session] ${sessionId}: liveness probe failed:`, error);
    }
    if (place === "host" || !containerId) return "unreachable";
    try {
        return await withContainerPorts(hostId, async (ports) => {
            const state = await containerState(ports, containerId);
            if (state === "stopped") await ports.container(containerId, "start");
            return state === "gone" ? "gone" : "unreachable";
        });
    } catch {
        return "unreachable";
    }
}

/**
 * Bring a server session's terminal back after the server restarted under it.
 *
 * The same boot as the first start, with a new reporting token: the checkout is
 * still there, so the boot reopens on it instead of cloning (see
 * PREPARE_WORKTREE) and starts the agent on the conversation it was in. False
 * when it could not, which leaves the sweep to fail the session as before.
 */
async function reopenOnHost(sessionId: string): Promise<boolean> {
    try {
        const reissued = await reissueSessionToken(sessionId);
        if (!reissued) return false;
        const boot = await bootstrapFor(reissued.session, reissued.token);
        await startOnHost(reissued.session, boot);
        await addSessionMessage(
            sessionId,
            "system",
            "The server restarted, so Polaris reopened this session on its checkout."
        ).catch(() => undefined);
        return true;
    } catch (error) {
        console.error(`[agent-session] ${sessionId}: could not reopen on its server:`, error);
        return false;
    }
}
