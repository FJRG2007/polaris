/**
 * Who has actually looked at a credential.
 *
 * The vault is opened in the browser and the server never holds the key, so
 * there is no such thing as the server observing somebody read a password.
 * Every item arrives at once, encrypted, on unlock - a log built from what the
 * server saw would say "this account opened its vault" and nothing more, which
 * is the sort of log that looks like an answer and is not one.
 *
 * So the deliberate act is what gets recorded, and the browser is what reports
 * it: revealing a password, copying one, taking the six digits, handing the item
 * out as a link. That is a client-reported fact, and the shape of the guarantee
 * has to be said plainly rather than implied - somebody with this account's
 * session could copy a password and not report it. It is a record of use, not a
 * seal against a determined insider, and it is worth having for exactly the case
 * it does answer: a shared vault where four people hold the key and one of them
 * took the production credential last Tuesday.
 *
 * Two things are checked before anything is written. That the reporting account
 * can actually reach the item - otherwise the log would be a way to write rows
 * about somebody else's vault - and that the action is one of the ones named
 * here, so the log cannot be filled with invented words.
 *
 * Nothing about the value is stored. Not the password, not its length, not a
 * hash of it: the row says who, which item, which kind of use, and when.
 */

import { prisma } from "@polaris/db";
import { recordAudit } from "@/lib/audit-service";
import { reachableCipherFilter } from "@/lib/vault/ciphers";
import { ITEM_USES, type ItemUse, type ItemUseEntry } from "@/lib/vault/item-uses";

/** The action names these become in the global log, which is one namespace for
 *  the whole of Polaris. */
const AUDIT_ACTION: Record<ItemUse, string> = {
    reveal: "vault.item.reveal",
    copy: "vault.item.copy",
    totp: "vault.item.totp",
    share: "vault.item.share"
};

/** The log's own name for what a row is about. */
const TARGET = "vault-item";

/** Whether this account may see the item at all. The same rule the vault itself
 *  reads by, so the log can never be more permissive than the vault. */
async function mayReach(userId: string, cipherId: string): Promise<boolean> {
    const filter = await reachableCipherFilter(userId);
    const row = await prisma.vaultCipher.findFirst({
        where: { AND: [{ id: cipherId }, filter] },
        select: { id: true }
    });
    return row !== null;
}

/** Record one use of an item. Silent about an item this account cannot reach:
 *  answering would tell a stranger which ids exist. */
export async function recordItemUse(
    userId: string,
    cipherId: string,
    use: ItemUse
): Promise<void> {
    if (!(await mayReach(userId, cipherId))) return;
    await recordAudit({
        actorId: userId,
        action: AUDIT_ACTION[use],
        targetType: TARGET,
        targetId: cipherId
    });
}

/** The reverse of AUDIT_ACTION, for reading rows back. */
const USE_BY_ACTION = new Map<string, ItemUse>(
    ITEM_USES.map((use) => [AUDIT_ACTION[use], use] as const)
);

/**
 * What has been done with one item, newest first.
 *
 * Empty for an item this account cannot reach, which is the same answer as an
 * item with no history - the two must not be told apart from outside.
 */
export async function listItemUses(
    userId: string,
    cipherId: string,
    limit = 25
): Promise<ItemUseEntry[]> {
    if (!(await mayReach(userId, cipherId))) return [];
    const rows = await prisma.auditLog.findMany({
        where: { targetType: TARGET, targetId: cipherId, action: { in: [...USE_BY_ACTION.keys()] } },
        orderBy: { at: "desc" },
        take: limit,
        select: { id: true, actorId: true, action: true, at: true }
    });
    if (rows.length === 0) return [];

    // One query for the names rather than a join per row, and an account that has
    // since been deleted reads as "somebody who has left" rather than dropping
    // the line - the use happened whether or not the account still exists.
    const actorIds = [...new Set(rows.map((row) => row.actorId).filter((id): id is string => Boolean(id)))];
    const people = await prisma.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, name: true, username: true }
    });
    const names = new Map(people.map((person) => [person.id, person.name || person.username || "Somebody"]));

    return rows.map((row) => ({
        id: row.id,
        at: row.at.toISOString(),
        use: USE_BY_ACTION.get(row.action) ?? "reveal",
        actor: row.actorId ? (names.get(row.actorId) ?? "Somebody who has left") : "Polaris",
        isSelf: row.actorId === userId
    }));
}
