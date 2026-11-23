/**
 * The account's Polaris Terminals as the web screen (/account/terminals) shows
 * them: the ones it signed in, and the ones somebody shared with it. Online is
 * whether a relay socket is open for it right now (`relayNode`), never a poll.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { revokeApiKey } from "@polaris/auth";
import { forgetSubject } from "@/lib/access/forget";
import { grantedSubjects } from "@/lib/access/grants";
import { TERMINAL_GRANT } from "@/lib/terminal/relay";

/** How many terminals one list returns. A person has a handful; the cap only
 *  keeps a runaway account from returning an unbounded page. */
const LIST_MAX = 200;

export const terminalLabelSchema = z.string().trim().min(1).max(60);

export interface TerminalView {
    readonly id: string;
    readonly name: string | null;
    readonly os: string | null;
    readonly version: string | null;
    readonly online: boolean;
    readonly lastSeenAt: string | null;
    readonly createdAt: string;
    /** `owner` for the account's own; otherwise what a share of it gives. */
    readonly access: "owner" | "view" | "control";
    /** Whose terminal it is, for a shared one. */
    readonly ownerName: string | null;
}

const select = {
    id: true,
    name: true,
    label: true,
    os: true,
    version: true,
    relayNode: true,
    lastSeenAt: true,
    createdAt: true,
    user: { select: { name: true } }
} as const;

type Row = {
    id: string;
    name: string | null;
    label: string | null;
    os: string | null;
    version: string | null;
    relayNode: string | null;
    lastSeenAt: Date | null;
    createdAt: Date;
    user: { name: string | null };
};

function view(row: Row, access: TerminalView["access"]): TerminalView {
    return {
        id: row.id,
        name: row.label ?? row.name,
        os: row.os,
        version: row.version,
        online: Boolean(row.relayNode),
        lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        access,
        ownerName: access === "owner" ? null : row.user.name
    };
}

/** A key that still lets its terminal in. */
const liveKey = { revokedAt: null, enabled: true } as const;

export async function listTerminals(userId: string): Promise<{ owned: TerminalView[]; shared: TerminalView[] }> {
    const [owned, grants] = await Promise.all([
        prisma.terminalInstance.findMany({
            where: { userId, apiKey: liveKey },
            select,
            orderBy: [{ lastSeenAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
            take: LIST_MAX
        }),
        grantedSubjects(userId, TERMINAL_GRANT)
    ]);
    const sharedIds = [...grants.keys()].slice(0, LIST_MAX);
    const shared =
        sharedIds.length === 0
            ? []
            : await prisma.terminalInstance.findMany({
                  where: { id: { in: sharedIds }, userId: { not: userId }, apiKey: liveKey },
                  select,
                  orderBy: { createdAt: "desc" }
              });
    return {
        owned: owned.map((row) => view(row, "owner")),
        shared: shared.map((row) => view(row, grants.get(row.id) === "control" ? "control" : "view"))
    };
}

/** One terminal the caller may at least watch, or null. */
export async function terminalFor(userId: string, id: string): Promise<TerminalView | null> {
    const { owned, shared } = await listTerminals(userId);
    return owned.find((one) => one.id === id) ?? shared.find((one) => one.id === id) ?? null;
}

export async function renameTerminal(userId: string, id: string, label: string): Promise<boolean> {
    const done = await prisma.terminalInstance.updateMany({ where: { id, userId }, data: { label } });
    return done.count === 1;
}

/**
 * Sign a terminal out: its key is revoked (kept for the audit trail), its row
 * and every share of it go. The relay closes its socket on the next standing
 * check, within a minute, and it cannot come back without signing in again.
 */
export async function revokeTerminal(userId: string, id: string): Promise<boolean> {
    const row = await prisma.terminalInstance.findFirst({ where: { id, userId }, select: { apiKeyId: true } });
    if (!row) return false;
    await revokeApiKey(userId, row.apiKeyId);
    await prisma.terminalInstance.deleteMany({ where: { id, userId } });
    await forgetSubject("terminal.instance", id);
    return true;
}
