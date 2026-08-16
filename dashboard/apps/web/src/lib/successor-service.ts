/**
 * The account somebody named to take over their own if they die.
 *
 * It is a designation, not a role. Naming one grants nothing that reads or
 * writes another person's work: what it does is put a second name on the small
 * set of acts that would otherwise die with the only person allowed to perform
 * them - today, ending an organization that account owns. Every place that
 * widens it has to ask here, so the list of what a successor can do stays
 * readable in one grep rather than accumulating quietly across features.
 *
 * Only the account itself ever writes its own row. An administrator can do a
 * great deal on this instance and cannot do this: a successor that somebody else
 * could appoint is not a successor, it is a back door with a kind name.
 */

import { prisma } from "@polaris/db";
import { normalizePersonName } from "@polaris/core";
import { contactLines } from "@/lib/privacy-service";

/** Raised when the person named cannot be resolved to exactly one account. The
 *  message is written to be shown; nothing here leaks whether an address that
 *  did not match belongs to somebody, only that it matched nobody. */
export class SuccessorError extends Error {}

/** The successor as the settings card draws them. */
export interface SuccessorView {
    readonly userId: string;
    readonly name: string;
    /** What the screen may say under their name: their address only when they
     *  show it to the account that named them. */
    readonly contact: string;
    readonly username: string | null;
    /** When the holder clicked through the acknowledgement. */
    readonly acknowledgedAt: Date;
}

export async function getSuccessor(userId: string): Promise<SuccessorView | null> {
    const row = await prisma.accountSuccessor.findUnique({
        where: { userId },
        select: {
            acknowledgedAt: true,
            successor: { select: { id: true, name: true, email: true, username: true } }
        }
    });
    if (!row) return null;
    const contacts = await contactLines({ id: userId, isAdmin: false }, [row.successor]);
    return {
        userId: row.successor.id,
        name: row.successor.name,
        contact: contacts.get(row.successor.id) ?? "",
        username: row.successor.username,
        acknowledgedAt: row.acknowledgedAt
    };
}

/**
 * Find the one account a typed identifier means.
 *
 * A username or an address is unique, so it answers on its own. A name is not,
 * which is why two people called the same thing is an error rather than a guess:
 * the whole point of the field is to hand somebody your account, and picking the
 * wrong Ana Garcia is not a mistake anybody would catch by reading the row back.
 *
 * The name is compared after the same normalization every name is stored
 * through, so "ana  garcia" finds the account written "Ana Garcia" without the
 * lookup depending on which database is underneath.
 */
async function findPerson(identifier: string): Promise<{ id: string; name: string }> {
    const login = identifier.trim().toLowerCase();
    const byLogin = await prisma.user.findFirst({
        where: { OR: [{ email: login }, { username: login }] },
        select: { id: true, name: true }
    });
    if (byLogin) return byLogin;

    const byName = await prisma.user.findMany({
        where: { name: normalizePersonName(identifier) },
        select: { id: true, name: true },
        take: 2
    });
    if (byName.length > 1) {
        throw new SuccessorError("More than one account has that name - use their username or email address");
    }
    if (byName.length === 0) throw new SuccessorError("No account matches that username, name or email address");
    return byName[0]!;
}

/**
 * Name a successor, replacing whoever was named before.
 *
 * The acknowledgement instant is rewritten every time, because it is consent to
 * this designation and not to the idea of having one: somebody who moves their
 * successor from one person to another has agreed to the second arrangement, on
 * the day they did it.
 */
export async function setSuccessor(userId: string, identifier: string): Promise<SuccessorView> {
    const person = await findPerson(identifier);
    if (person.id === userId) throw new SuccessorError("Name somebody else - you cannot succeed yourself");

    const acknowledgedAt = new Date();
    await prisma.accountSuccessor.upsert({
        where: { userId },
        create: { userId, successorId: person.id, acknowledgedAt },
        update: { successorId: person.id, acknowledgedAt }
    });
    const view = await getSuccessor(userId);
    if (!view) throw new SuccessorError("Could not name that successor");
    return view;
}

export async function clearSuccessor(userId: string): Promise<void> {
    await prisma.accountSuccessor.deleteMany({ where: { userId } });
}

/** Whether one account is the successor another account named. False whenever
 *  either id is missing, so a caller that has not resolved an owner cannot get a
 *  yes by passing nothing. */
export async function isSuccessorOf(candidateId: string, holderId: string): Promise<boolean> {
    if (!candidateId || !holderId || candidateId === holderId) return false;
    const row = await prisma.accountSuccessor.findUnique({
        where: { userId: holderId },
        select: { successorId: true }
    });
    return row?.successorId === candidateId;
}
