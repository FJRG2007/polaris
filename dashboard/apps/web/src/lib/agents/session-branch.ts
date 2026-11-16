/**
 * Which branch a session's screens name, if any.
 *
 * A session without a repository has no git at all, so it never has a branch to
 * show. One with a repository works on a branch of its own, but a session that
 * only answered a question has not touched it: naming `agent/hola-que-tal-...`
 * over a greeting reads as if something was written somewhere. So the branch
 * appears once the session has changed something - a file edit, a commit, saved
 * work or a pull request - and not before.
 */

import * as core from "@polaris/core";

/** The tools that write into the checkout, as each agent's hooks name them. */
const EDITING_TOOLS = new Set([
    "Write",
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "apply_patch",
    "write_file",
    "replace",
    "edit_file",
    "create_file"
]);

/** A shell command that moves the branch itself. */
const GIT_WRITE = /\bgit\s+(?:-c\s+\S+\s+)*(?:commit|merge|rebase|cherry-pick|am|push|revert)\b/;

/** Whether an event is the session changing something in its checkout. */
export function isChangeEvent(event: { kind: string; subject: string; detail: string }): boolean {
    if (event.kind !== "tool.start" && event.kind !== "tool.end") return false;
    if (EDITING_TOOLS.has(event.subject)) return true;
    return event.subject === "Bash" && GIT_WRITE.test(event.detail);
}

/**
 * When the session last finished changing its checkout, or null when it has
 * not: the time of its newest finished edit. A tool that is still writing has
 * nothing to show yet, so only `tool.end` counts.
 */
export function lastChangeAt(
    events: readonly { kind: string; subject: string; detail: string; at: string }[]
): string | null {
    let last: string | null = null;
    for (const event of events) {
        if (event.kind !== "tool.end" || !isChangeEvent(event)) continue;
        if (last === null || event.at > last) last = event.at;
    }
    return last;
}

/**
 * When the session last finished a tool that is not one of the named edits,
 * or null when it has not. A shell command can write as much as an edit tool
 * can, and no name says which ones did, so this is only a cue to look: the
 * workspace reads the checkout's fingerprint when it moves and wakes the
 * preview and the diffs only when that changed.
 */
export function lastToolAt(
    events: readonly { kind: string; subject: string; detail: string; at: string }[]
): string | null {
    let last: string | null = null;
    for (const event of events) {
        if (event.kind !== "tool.end" || EDITING_TOOLS.has(event.subject)) continue;
        if (last === null || event.at > last) last = event.at;
    }
    return last;
}

/** The branch to show for a session, or empty when it has none worth naming. */
export function shownSessionBranch(
    session: {
        readonly repoFullName: string;
        readonly branch: string;
        readonly work: { readonly state: string; readonly commits: number } | null;
        readonly pullRequest: unknown;
    },
    events: readonly { kind: string; subject: string; detail: string }[] = []
): string {
    if (!session.repoFullName || !session.branch) return "";
    const changed =
        session.pullRequest !== null ||
        session.work?.state === "pushed" ||
        (session.work?.commits ?? 0) > 0 ||
        events.some(isChangeEvent);
    return changed ? session.branch : "";
}

/** The branch a new session is stored with: none without a repository. */
export function createdSessionBranch(sessionId: string, repoId: string | null, title: string): string {
    return repoId ? core.sessionBranchName(sessionId, title) : "";
}
