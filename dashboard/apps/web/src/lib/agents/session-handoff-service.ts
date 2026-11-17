/**
 * Reading a session's conversation into what a new agent starts with
 * (`session-handoff`), and carrying the conversation over to the session that
 * continues it, so the person sees it go on where it ended.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import * as handoff from "./session-handoff";

/** The most history rows copied onto the session that carries on, newest kept. */
export const COPIED_MESSAGES_MOST = 500;

/** Marks a copied row, so the transcript sync never takes it for a line of its own. */
const COPIED_PREFIX = "carried:";

export interface HandoffSource {
    readonly id: string;
    readonly title: string;
    readonly cli: string;
    readonly branch: string;
    readonly repoFullName: string;
}

/** A tool's name as the note says it. */
export function agentLabel(cli: string): string {
    return core.agentCliById(cli)?.label ?? cli;
}

/** The newest stored messages, oldest first, bounded. */
async function storedMessages(sessionId: string, take: number) {
    const rows = await prisma.agentSessionMessage.findMany({
        where: { sessionId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take,
        select: { role: true, kind: true, subject: true, ref: true, body: true, authorId: true, vendorId: true, createdAt: true }
    });
    return rows.reverse();
}

/** The note and the conversation file for the session that takes over from `source`. */
export async function handoffFor(
    source: HandoffSource,
    { kind, targetCli, at = new Date() }: { kind: "switch" | "restore"; targetCli: string; at?: Date }
): Promise<{ note: string; file: { path: string; text: string } }> {
    const rows = await storedMessages(source.id, handoff.HANDOFF_MESSAGES_MOST);
    const messages = rows.map((row) => ({
        role: row.role,
        kind: row.kind,
        subject: row.subject,
        body: row.body,
        at: row.createdAt.toISOString()
    }));
    const turns = handoff.handoffTurns(messages);
    const sourceAgent = agentLabel(source.cli);
    const note = handoff.buildHandoffNote({
        kind,
        sourceAgent,
        targetAgent: agentLabel(targetCli),
        title: source.title,
        repository: source.repoFullName,
        branch: source.branch,
        at,
        originalTask: turns.find((turn) => turn.userRequest)?.userRequest ?? "",
        turns,
        fullHistoryPath: handoff.HANDOFF_FILE
    });
    return {
        note,
        file: { path: handoff.HANDOFF_FILE, text: handoff.conversationFile({ title: source.title, sourceAgent }, messages) }
    };
}

/**
 * The conversation so far, copied onto the session that continues it, with
 * the times it was said. Rows keep their order and their pairing; each gets a
 * vendor id of its own so the new session's transcript sync never matches it.
 */
export async function copyHistory(fromId: string, toId: string): Promise<number> {
    const rows = await storedMessages(fromId, COPIED_MESSAGES_MOST);
    if (rows.length === 0) return 0;
    const created = await prisma.agentSessionMessage.createMany({
        data: rows.map((row, index) => ({
            sessionId: toId,
            role: row.role,
            kind: row.kind,
            subject: row.subject,
            ref: row.ref,
            body: row.body,
            authorId: row.authorId,
            vendorId: `${COPIED_PREFIX}${fromId}:${index}`,
            createdAt: row.createdAt
        })),
        skipDuplicates: true
    });
    return created.count;
}
