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
import { containerState, withContainerPorts } from "./session-ports";
import { getHostConnectionUnscoped } from "@/lib/host-service";
import { sessionCredentials } from "@/lib/agents/agent-readiness";
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
import { endContainerSession, type SaveOutcome } from "./session-work";
import { clearSessionWaiting, noticeSessionEnded } from "./agent-notices";
import { syncFinalSessionHistory } from "./session-history";
import { totalCeiling } from "./session-capacity";
import { startContainer } from "./session-container";
import { claimSpare } from "./session-spares";
import { previewBase } from "./session-preview-link";
import * as placement from "./session-placement";
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
    type SessionView
} from "./session-service";


/** Where a `local` session's worktree lives inside its own container: on the
 *  session's own directory on the box, so it outlives the container. See
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
    /** `ENV=relative/path` pairs, space separated: which of `credentials` are
     *  a file the tool keeps, and where. Names and paths from the catalogue. */
    readonly credentialFiles: string;
    readonly mcpConfig: string;
    readonly cloneHeader: string;
    /** The credential helper script, or empty for a workspace. */
    readonly gitCredential: string;
    /** The repository's own setup script, encoded, or empty for none. */
    readonly repoSetup: string;
    /** Whether a failing setup script stops the session before the agent starts. */
    readonly repoSetupRequired: boolean;
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
    const chosen = core.permissionModeArgs(cli.id, session.permissionMode);
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
    return {
        cli,
        binary,
        command: [binary, ...args, ...modelArgs].join(" "),
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

/** The parent's transcript a forked session reopens, or empty for any other. */
async function forkTranscriptFor(session: SessionView, cli: string): Promise<string> {
    if (!session.parentId) return "";
    const parent = await forkSource(session.parentId);
    if (!parent) return "";
    return fork.forkTranscript({ ...session, cli }, parent);
}

async function bootstrapFor(session: SessionView, token: string): Promise<Bootstrap> {
    // A workspace checks nothing out, so it needs no installation and asks for
    // no token. Refusing to start one because an organization has not connected
    // GitHub would be refusing over a repository nobody named.
    const githubToken = session.repoFullName ? await cloneToken(session.repoFullName) : "";
    const setup = session.repoId ? await repoSetupFor(session.repoId) : null;

    const base = (await appBaseUrl()).replace(/\/+$/, "");
    const ingest = `${base}/api/agents/sessions/${session.id}/events`;
    const mcp = `${base}/api/mcp`;
    const credential = `${base}/api/agents/sessions/${session.id}/git-credential`;
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
    const modelEnv = await modelEnvFor(session);
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
            agent.cli.id === "claude" ? `${base}/api/agents/sessions/${session.id}/permission` : undefined
        ),
        hookSettings: JSON.stringify(
            claudeHookSettings(`${stateDirFor(session)}/hook.sh`, { headless: headless !== "" })
        ),
        mcpConfig: JSON.stringify(mcpConfig(mcp, token)),
        // Empty for a workspace, which clones nothing. A header built around an
        // empty token is a header git would send.
        cloneHeader: githubToken ? (cloneAuthHeader(githubToken) ?? "") : "",
        // Not a token: a script that asks for one. The agent's environment holds
        // no GitHub credential at all.
        gitCredential: session.repoFullName ? gitCredentialScript(credential, token) : "",
        repoSetup: setup?.setupScript.trim() ? asFile(setup.setupScript) : "",
        repoSetupRequired: setup?.setupRequired ?? false,
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
        credentials: {
            ...sessionCredentials(agent.cli, available, chosen, session.useMachineLogin),
            // The provider and model picked on the form, last, so they win.
            ...modelEnv
        },
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
    for (const command of attachments.attachmentCommands(workdirFor(session), bytes)) {
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
        POLARIS_ENIGMA_SETUP: boot.enigmaSetup,
        POLARIS_ENIGMA_CONFIGURE: boot.enigmaConfigure,
        POLARIS_FIRST_RUN: boot.firstRun,
        POLARIS_HOOK_SCRIPT: asFile(boot.hookScript),
        POLARIS_HOOK_SETTINGS: asFile(boot.hookSettings),
        POLARIS_CREDENTIAL_FILES: boot.credentialFiles,
        POLARIS_MCP_CONFIG: asFile(boot.mcpConfig),
        POLARIS_GIT_CREDENTIAL: boot.gitCredential ? asFile(boot.gitCredential) : "",
        POLARIS_REPO_SETUP: boot.repoSetup,
        POLARIS_REPO_SETUP_REQUIRED: boot.repoSetupRequired ? "yes" : "",
        // Told to the agent, so a framework that needs its base path can be
        // started under it (see PREVIEW_PROMPT).
        POLARIS_PREVIEW_BASE: boot.previewBase,
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
        const ready = await runInSession(
            sessionId,
            `${commands.runnerReadyCommand(stateDirFor(placement))} || { ${commands.agentReadyCommand()}; }`
        ).catch(() => null);
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
    // A session whose runner takes its prompts gets this one as a file in the
    // queue: nothing typed, nothing that has to look ready first.
    const placement = await sessionPlacement(sessionId);
    if (!placement) throw new Error("That session no longer exists.");
    const queued = await runInSession(
        sessionId,
        commands.queuePromptCommand(stateDirFor(placement), text)
    ).catch(() => null);
    if (queued?.code === 0) return;
    // The interface is open beside the runner: the prompt goes to it, typed.
    const target =
        queued?.code === commands.NOT_QUEUED.interfaceOpen
            ? `${commands.TMUX_SESSION}:${commands.INTERFACE_WINDOW}`
            : commands.TMUX_SESSION;
    if (queued && queued.code !== commands.NOT_QUEUED.interactive && target === commands.TMUX_SESSION)
        throw new Error("The agent's machine did not take the prompt");
    await steer(sessionId, commands.pastePromptCommand(text, target), "The agent's terminal did not take the prompt");
    await new Promise((resolve) => setTimeout(resolve, commands.submitDelayMs(text)));
    await steer(sessionId, commands.submitCommand(target), "The prompt was pasted but not submitted");
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
    const placement = await sessionPlacement(sessionId);
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
    const result = await runInSession(sessionId, commands.openInterfaceCommand(stateDirFor(placement)));
    if (result.code === 0) return "opened";
    if (result.code === commands.NOT_OPENED.interactive) return "interactive";
    if (result.code === commands.NOT_OPENED.turnRunning) return "busy";
    throw new Error("The session's terminal did not open the agent's interface");
}

/** Bring the agent back on its conversation, typed into the shell it left. */
export async function resumeAgent(sessionId: string, vendorSessionId: string): Promise<void> {
    await steer(
        sessionId,
        commands.resumeCommand(vendorSessionId),
        "The session's terminal did not take the resume"
    );
    await steer(sessionId, commands.submitCommand(), "The resume was typed but not submitted");
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
    // Whoever pressed Stop has answered whatever it was waiting on.
    await clearSessionWaiting(sessionId);
    await syncFinalSessionHistory(sessionId);
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
