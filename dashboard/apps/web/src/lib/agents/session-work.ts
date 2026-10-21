/**
 * Saving the work in a session's container before the container goes.
 *
 * A `local` session's checkout lives in a container Polaris removes when the
 * session ends - Stop, or the sweep of sessions that went silent - and anything
 * the agent committed but did not push, or never committed at all, went with
 * it. So before the container is touched, whatever is there is committed as a
 * work-in-progress commit on the session's branch and pushed, never forced, with
 * a fresh token for the installation the clone used. If that push does not go
 * through, the container is not removed: it is kept, the session says so, and
 * its owner is told, with a button to try again or to let it go.
 *
 * A session on somebody's own server is not touched: its worktree stays on that
 * server when the session ends, so there is nothing to save.
 */

import { prisma } from "@polaris/db";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { shellPath, shellQuote } from "./session-hooks";
import * as commands from "./session-commands";
import { HostdPorts } from "@/lib/deploy/ports-hostd";
import type { SessionWorkReason } from "./session-service";
import { clearWorkKept, noticeWorkKept } from "./agent-notices";
import {
    cloneAuthHeader,
    resolveGithubRepo,
    githubAppInstallationToken
} from "@/lib/github-service";

/** Where a checkout lives inside a session's container when the row has none. */
const DEFAULT_WORKDIR = "/session/repo";

/** The line the script ends on, which is all of its output this reads. */
const MARK = "polaris-work:";

/** How much of git's own complaint is kept, from the end. Far under the 16 KiB
 *  the daemon returns, so the status line after it is never what gets cut. */
const TAIL_BYTES = 800;

const WIP_MESSAGE = "WIP: work left in the session when it stopped";

export interface SaveWorkInput {
    workdir: string;
    /** The session's own branch: the only one the work is ever pushed to,
     *  whatever the checkout has on it now. */
    branch: string;
    /** The repository's default branch as GitHub reports it, or empty when
     *  that could not be asked. Never pushed to, under any policy. */
    defaultBranch: string;
    /** The repository's push setting: `disabled`, `restricted` or `enabled`. */
    policy: string;
    /** Where in the container the push credential was written, or empty for
     *  none. The script reads it and deletes it. */
    authFile: string;
    /** The commit message for what is dirty. The work-in-progress one when
     *  omitted, which is what a session that stopped leaves behind. */
    message?: string;
}

/**
 * The script that commits what is dirty and pushes the branch.
 *
 * Pure, so every branch of it can be asserted. Its output is bounded: git
 * status is never printed - only whether there is a first line of it - commit
 * counts are numbers, and git's complaint on a failed push is cut to its last
 * few hundred bytes, so the one status line it ends on always survives the
 * daemon's 16 KiB cap.
 *
 * The credential goes to git through `GIT_CONFIG_*` environment, never as an
 * argument: an argument is readable by anything that can list processes.
 */
export function saveWorkScript(input: SaveWorkInput): string {
    return [
        "export GIT_TERMINAL_PROMPT=0",
        `cd ${shellPath(input.workdir)} 2>/dev/null || { echo "${MARK} none 0 -"; exit 0; }`,
        // Whoever the daemon runs this as, the checkout may belong to the agent's
        // own account, and git refuses a repository owned by somebody else.
        "g() { git -c safe.directory='*' \"$@\"; }",
        `g rev-parse --git-dir >/dev/null 2>&1 || { echo "${MARK} none 0 -"; exit 0; }`,
        `branch=${shellQuote(input.branch)}`,
        // Exactly one line of status at most: whether there is anything, not what.
        "dirty=$(g status --porcelain 2>/dev/null | head -n 1 | wc -l | tr -d ' ')",
        // Not reachable from anything the remote is known to have.
        "ahead() { g rev-list --count HEAD --not --remotes 2>/dev/null || echo 0; }",
        'if [ "$dirty" = "0" ] && [ "$(ahead)" = "0" ]; then',
        `  [ -n ${shellQuote(input.authFile)} ] && rm -f ${shellQuote(input.authFile)}`,
        `  echo "${MARK} clean 0 $branch"; exit 0`,
        "fi",
        'if [ "$dirty" != "0" ]; then',
        // A commit by whoever the agent's own git is configured as; Polaris only
        // when there is nobody.
        "  if ! g config user.email >/dev/null 2>&1; then",
        "    export GIT_AUTHOR_NAME=Polaris GIT_COMMITTER_NAME=Polaris",
        "    export GIT_AUTHOR_EMAIL=agent@polaris.invalid GIT_COMMITTER_EMAIL=agent@polaris.invalid",
        "  fi",
        `  g add -A >/dev/null 2>&1 && g commit -q --no-verify -m ${shellQuote(input.message ?? WIP_MESSAGE)} >/dev/null 2>&1 || { echo "${MARK} failed $(ahead) $branch"; exit 0; }`,
        "fi",
        "count=$(ahead)",
        `policy=${shellQuote(input.policy)}`,
        'if [ "$policy" = "disabled" ]; then',
        `  echo "${MARK} refused $count $branch"; exit 0`,
        "fi",
        // Never the repository's default branch, whatever the policy.
        `default=${shellQuote(input.defaultBranch)}`,
        "remote=$(g symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')",
        'if [ -z "$branch" ] || [ "$branch" = "$default" ] || [ "$branch" = "$remote" ]; then',
        `  [ -n ${shellQuote(input.authFile)} ] && rm -f ${shellQuote(input.authFile)}`,
        `  echo "${MARK} refused $count \${branch:--}"; exit 0`,
        "fi",
        `auth=""`,
        `if [ -n ${shellQuote(input.authFile)} ] && [ -f ${shellQuote(input.authFile)} ]; then`,
        `  auth=$(cat ${shellQuote(input.authFile)}); rm -f ${shellQuote(input.authFile)}`,
        "fi",
        'if [ -z "$auth" ]; then',
        `  echo "${MARK} noauth $count $branch"; exit 0`,
        "fi",
        // Never forced: a branch that moved on is a refusal, and the work stays.
        'out=$(GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="$auth" g push origin "HEAD:refs/heads/$branch" 2>&1)',
        "code=$?",
        'if [ "$code" = "0" ]; then',
        `  echo "${MARK} pushed $count $branch"; exit 0`,
        "fi",
        `printf '%s\\n' "$out" | tail -c ${TAIL_BYTES}`,
        `echo "${MARK} rejected $count $branch"`
    ].join("\n");
}

export type SaveStatus = "none" | "clean" | "pushed" | "refused" | "noauth" | "rejected" | "failed";

export interface ParsedSave {
    status: SaveStatus;
    commits: number;
    branch: string;
    /** What git said before the status line, for a failed push. */
    said: string;
}

const STATUSES: readonly SaveStatus[] = [
    "none",
    "clean",
    "pushed",
    "refused",
    "noauth",
    "rejected",
    "failed"
];

/** The script's last status line, or null when it never got that far. */
export function parseSaveWork(output: string): ParsedSave | null {
    const lines = output.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]!.trim();
        if (!line.startsWith(MARK)) continue;
        const [status, commits, branch] = line.slice(MARK.length).trim().split(/\s+/);
        if (!status || !(STATUSES as readonly string[]).includes(status)) return null;
        return {
            status: status as SaveStatus,
            commits: Math.max(0, Number.parseInt(commits ?? "0", 10) || 0),
            branch: branch && branch !== "-" ? branch : "",
            said: lines.slice(0, index).join("\n").trim()
        };
    }
    return null;
}

/** Why a push that ran did not land, from what git printed. */
export function pushFailureReason(said: string): SessionWorkReason {
    if (
        /authentication failed|could not read username|permission to .* denied|\b403\b|\b401\b/i.test(
            said
        )
    )
        return "auth";
    if (/rejected|protected branch|non-fast-forward|fetch first|declined/i.test(said))
        return "rejected";
    return "other";
}

/** What became of a session's work. */
export type SaveOutcome =
    | { kind: "none" }
    | { kind: "clean"; branch: string }
    | { kind: "pushed"; commits: number; branch: string }
    | { kind: "kept"; commits: number; branch: string; reason: SessionWorkReason };

/** Runs a script on the server a `host` session lives on, through its stdin. */
export type HostScriptRunner = (script: string) => Promise<{ output: string }>;

export interface SaveWorkOptions {
    /** The commit message for what is dirty; the work-in-progress one by default. */
    message?: string;
    /** Refuse the repository's default branch even where its push setting would
     *  allow it. What shipping asks for: a pull request is never opened from it. */
    neverDefault?: boolean;
    /** How to reach a session on a server. Without it a server session is left
     *  alone, which is what ending one wants: its worktree stays there. */
    host?: HostScriptRunner;
}

/** Commit and push whatever a session's checkout holds - a `local` session's
 *  container, or a server's worktree when `host` says how to reach it. Never
 *  throws: anything that goes wrong is a kept outcome, because the one thing
 *  this may not do is report "nothing to save" about work it could not look at. */
export async function saveSessionWork(
    sessionId: string,
    options: SaveWorkOptions = {}
): Promise<SaveOutcome> {
    const row = await prisma.agentSession.findUnique({
        where: { id: sessionId },
        select: {
            place: true,
            containerId: true,
            workdir: true,
            branch: true,
            repo: { select: { repoFullName: true, push: true } }
        }
    });
    if (!row || !row.repo?.repoFullName) return { kind: "none" };
    const onHost = row.place === "host";
    if (onHost ? !options.host : !row.containerId) return { kind: "none" };
    const policy = options.neverDefault && row.repo.push === "enabled" ? "restricted" : row.repo.push;

    const ports = new HostdPorts();
    const kept = (reason: SessionWorkReason, commits = 0, branch = row.branch): SaveOutcome => ({
        kind: "kept",
        commits,
        branch,
        reason
    });

    let authFile = "";
    let defaultBranch = "";
    // On a server the script travels through sshd's stdin, never a command line,
    // so the credential can be written by the script itself; a container is
    // reached through an argv the daemon can see, so it gets a file first.
    let prelude = "";
    if (policy !== "disabled") {
        const [owner = "", name = ""] = row.repo.repoFullName.split("/");
        const token = await githubAppInstallationToken(owner).catch(() => null);
        const repo = token ? await resolveGithubRepo(owner, name, token).catch(() => null) : null;
        if (token && !repo) return kept("unreachable");
        defaultBranch = repo?.defaultBranch ?? "";
        const header = cloneAuthHeader(token);
        if (header) {
            const path = `/tmp/polaris-push-${randomUUID()}`;
            if (onHost) {
                prelude = `(umask 077; printf '%s' ${shellQuote(header)} > ${shellQuote(path)})\n`;
                authFile = path;
            } else {
                const bytes = Buffer.from(header, "utf8");
                try {
                    await ports.writeFile(row.containerId!, path, Readable.from([bytes]), bytes.length);
                    authFile = path;
                } catch (error) {
                    console.error(
                        `polaris: could not hand session ${sessionId} its push credential:`,
                        error
                    );
                    return kept("unreachable");
                }
            }
        }
    }

    let output: string;
    try {
        const script = saveWorkScript({
            workdir: row.workdir || DEFAULT_WORKDIR,
            branch: row.branch,
            defaultBranch,
            policy,
            authFile,
            message: options.message
        });
        const result = onHost
            ? await options.host!(prelude + script)
            : await ports.runIn(row.containerId!, commands.shellArgv(script));
        output = result.output;
    } catch (error) {
        console.error(`polaris: could not reach session ${sessionId} to save its work:`, error);
        return kept("unreachable");
    }

    const parsed = parseSaveWork(output);
    if (!parsed) {
        console.error(`polaris: saving the work of session ${sessionId} said nothing usable`);
        return kept("other");
    }
    const branch = parsed.branch || row.branch;
    switch (parsed.status) {
        case "none":
            return { kind: "none" };
        case "clean":
            return { kind: "clean", branch };
        case "pushed":
            return { kind: "pushed", commits: parsed.commits, branch };
        case "refused":
            return kept("policy", parsed.commits, branch);
        case "noauth":
            return kept("auth", parsed.commits, branch);
        case "rejected":
            console.error(`polaris: the push for session ${sessionId} was refused:`, parsed.said);
            return kept(pushFailureReason(parsed.said), parsed.commits, branch);
        default:
            return kept("other", parsed.commits, branch);
    }
}

/** Write the outcome on the session, for its page. */
async function recordOutcome(sessionId: string, outcome: SaveOutcome): Promise<void> {
    if (outcome.kind === "none") return;
    await prisma.agentSession.update({
        where: { id: sessionId },
        data: {
            workState: outcome.kind,
            workCommits: outcome.kind === "clean" ? 0 : outcome.commits,
            workBranch: outcome.branch,
            workError: outcome.kind === "kept" ? outcome.reason : null
        }
    });
}

/**
 * Save the work, then take the container down - or keep it, when the work
 * could not be saved. The one path Stop, the sweep, Try again and the reaper of
 * leftover containers all take, so none of them can remove a container the
 * others would have kept.
 *
 * Returns the outcome so a caller can answer the person who pressed something.
 */
export async function endContainerSession(sessionId: string): Promise<SaveOutcome> {
    const row = await prisma.agentSession.findUnique({
        where: { id: sessionId },
        select: { containerId: true }
    });
    const outcome = await saveSessionWork(sessionId);
    await recordOutcome(sessionId, outcome).catch((error) => {
        console.error(
            `polaris: could not record what became of session ${sessionId}'s work:`,
            error
        );
    });
    if (outcome.kind === "kept") {
        await noticeWorkKept(sessionId, outcome.branch);
        return outcome;
    }
    await clearWorkKept(sessionId);
    if (row?.containerId)
        await new HostdPorts().composeDown(row.containerId).catch(() => undefined);
    return outcome;
}

/** Let kept work go: the container is removed with it. */
export async function discardSessionWork(sessionId: string): Promise<void> {
    const row = await prisma.agentSession.findUnique({
        where: { id: sessionId },
        select: { containerId: true }
    });
    await prisma.agentSession.update({
        where: { id: sessionId },
        data: { workState: "discarded", workError: null }
    });
    await clearWorkKept(sessionId);
    if (row?.containerId)
        await new HostdPorts().composeDown(row.containerId).catch(() => undefined);
}
