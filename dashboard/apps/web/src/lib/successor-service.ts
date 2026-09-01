/**
 * The account somebody named to take over if they are gone.
 *
 * It is a designation, not a role. Naming one grants nothing that reads or
 * writes another person's work: what it does is put a second name on the small
 * set of acts that would otherwise die with the only person allowed to perform
 * them - today, ending an organization. Every place that widens it has to ask
 * here, so the list of what a successor can do stays readable in one grep rather
 * than accumulating quietly across features.
 *
 * **There are two of them, and the second is why this file has grown.** A person
 * names who takes over *their account*; an organization names who takes over
 * *it*. An owner of four organizations may well want a different person to close
 * each one - the colleague who ran it, rather than their brother - and until
 * there was a row per organization the only answer was the one on the account,
 * which is right for a household and wrong for anywhere with more than one team.
 *
 * An organization with none named falls back to its owner's, which is what
 * happened before and what most owners will never have to think about. That
 * fallback is the whole compatibility story: nothing changes for an instance
 * where nobody opens the new card.
 *
 * Only the holder ever writes their own row - the account itself, or the
 * organization's owner. An administrator can do a great deal on this instance
 * and cannot do this: a successor that somebody else could appoint is not a
 * successor, it is a back door with a kind name.
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
        throw new SuccessorError(
            "More than one account has that name - use their username or email address"
        );
    }
    if (byName.length === 0)
        throw new SuccessorError("No account matches that username, name or email address");
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
    if (person.id === userId)
        throw new SuccessorError("Name somebody else - you cannot succeed yourself");

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

// ---------------------------------------------------------------------------
// An organization's own successor
// ---------------------------------------------------------------------------

/** What the organization's settings card draws. `inherited` says the name came
 *  from the owner's own account rather than from this organization, because a
 *  card that showed the two identically would let somebody think they had made a
 *  choice they had not. */
export interface OrgSuccessorView extends SuccessorView {
    readonly inherited: boolean;
}

/** The person this organization has named, or null. Nothing inherited: the
 *  fallback is applied by the callers that want it, so a screen can tell "we
 *  chose nobody" from "we chose them". */
export async function getOrgSuccessor(orgId: string): Promise<SuccessorView | null> {
    const row = await prisma.organizationSuccessor.findUnique({
        where: { orgId },
        select: {
            acknowledgedAt: true,
            successor: { select: { id: true, name: true, email: true, username: true } }
        }
    });
    if (!row) return null;
    // Asked as the organization's owner would be asked, which is what the card is
    // shown to: an address is only printed where its owner shows it to them.
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { ownerId: true }
    });
    const contacts = await contactLines(
        { id: org?.ownerId ?? "", isAdmin: false },
        [row.successor]
    );
    return {
        userId: row.successor.id,
        name: row.successor.name,
        contact: contacts.get(row.successor.id) ?? "",
        username: row.successor.username,
        acknowledgedAt: row.acknowledgedAt
    };
}

/**
 * Who answers for this organization, named here or inherited from its owner.
 *
 * The one function every screen should ask, because it is the only place the
 * fallback lives. `inherited` is what the card reads to say where the name came
 * from.
 */
export async function effectiveOrgSuccessor(orgId: string): Promise<OrgSuccessorView | null> {
    const own = await getOrgSuccessor(orgId);
    if (own) return { ...own, inherited: false };

    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { ownerId: true }
    });
    if (!org) return null;
    const owners = await getSuccessor(org.ownerId);
    return owners ? { ...owners, inherited: true } : null;
}

/**
 * Name one, replacing whoever was named before.
 *
 * The owner cannot name themselves: they already answer for the organization, and
 * a successor who is the person being succeeded is a row that means nothing. The
 * acknowledgement instant is rewritten every time, for the same reason it is on
 * an account - it is consent to this arrangement, not to the idea of having one.
 */
export async function setOrgSuccessor(orgId: string, identifier: string): Promise<SuccessorView> {
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { ownerId: true }
    });
    if (!org) throw new SuccessorError("That organization no longer exists");

    const person = await findPerson(identifier);
    if (person.id === org.ownerId) {
        throw new SuccessorError("Name somebody else - you already answer for this organization");
    }

    const acknowledgedAt = new Date();
    await prisma.organizationSuccessor.upsert({
        where: { orgId },
        create: { orgId, successorId: person.id, acknowledgedAt },
        update: { successorId: person.id, acknowledgedAt }
    });
    const view = await getOrgSuccessor(orgId);
    if (!view) throw new SuccessorError("Could not name that successor");
    return view;
}

/** Take the organization's own name off, which puts it back on the owner's. */
export async function clearOrgSuccessor(orgId: string): Promise<void> {
    await prisma.organizationSuccessor.deleteMany({ where: { orgId } });
}

/**
 * Whether this account may act as the successor for an organization.
 *
 * The organization's own name first, and the owner's only when it has none. Not
 * both: an organization that has named somebody has made a choice, and quietly
 * also honouring the owner's personal successor would widen it past what was
 * chosen - which is the one thing a designation like this must not do.
 */
export async function isOrgSuccessor(candidateId: string, orgId: string): Promise<boolean> {
    if (!candidateId || !orgId) return false;
    const row = await prisma.organizationSuccessor.findUnique({
        where: { orgId },
        select: { successorId: true }
    });
    if (row) return row.successorId === candidateId;

    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { ownerId: true }
    });
    if (!org) return false;
    return isSuccessorOf(candidateId, org.ownerId);
}
