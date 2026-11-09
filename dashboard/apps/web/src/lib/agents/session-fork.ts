/**
 * Forking a session: a new one on the same work, carrying the conversation
 * along where the agent can.
 *
 * Pure, so what a fork starts from and whether it takes the conversation with
 * it are decided in one place a test can ask.
 */

import { readableTranscriptPath } from "./session-transcript";

/** What decides which home a session's agent keeps its conversations in. */
export interface ForkPlace {
    readonly cli: string;
    readonly place: string;
    readonly hostId: string | null;
    readonly sharedHome: boolean;
    readonly ownerId: string | null;
}

/** The parts of the parent that say where its work and conversation are. */
export interface ForkParent extends ForkPlace {
    readonly branch: string;
    readonly baseRef: string;
    readonly work: { readonly state: string } | null;
    readonly pullRequest: { readonly number: number } | null;
}

/**
 * The ref a fork checks out: the parent's own branch once its work reached
 * GitHub, otherwise what the parent itself started from. A branch that was never
 * pushed does not exist anywhere the fork's machine could clone it from.
 */
export function forkBaseRef(parent: ForkParent): string {
    if (parent.pullRequest || parent.work?.state === "pushed") return parent.branch;
    return parent.baseRef;
}

/**
 * The parent's transcript the fork reopens with `--resume <path> --fork-session`,
 * or empty for a fork that starts on a fresh conversation.
 *
 * Only Claude Code: it is the one tool whose reference documents a fork of a
 * resumed conversation (`--fork-session`), and accepts the transcript's path in
 * place of an id. Only where both sessions keep the same home, because that is
 * where the transcript is: another person's home, the shared machine, or another
 * server is a file the fork's agent cannot open. The path is typed into a shell,
 * so it is held to plain path characters on top of the transcript shape.
 */
export function forkTranscript(
    child: ForkPlace,
    parent: ForkPlace & { readonly transcriptPath: string | null }
): string {
    if (child.cli !== "claude" || parent.cli !== "claude") return "";
    if (child.place !== parent.place || child.sharedHome !== parent.sharedHome) return "";
    if (child.place === "host" && child.hostId !== parent.hostId) return "";
    if (!child.sharedHome && (!child.ownerId || child.ownerId !== parent.ownerId)) return "";
    const path = parent.transcriptPath;
    if (!readableTranscriptPath(path) || !/^[A-Za-z0-9_./-]+$/.test(path)) return "";
    return path;
}
