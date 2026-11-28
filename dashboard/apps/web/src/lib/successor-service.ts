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

import { findableBy, resolveNamedAccount } from "@/lib/people-search";
import { prisma } from "@polaris/db";
import { NAME_SUCCESSOR_PURPOSE } from "@/lib/successor-constants";

export { NAME_SUCCESSOR_PURPOSE };
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

/** What a typed identifier turned out to mean, for the dialog that lets the
 *  holder pick before anything is asked of them. */
export type SuccessorLookup =
    | { kind: "match"; person: { userId: string; name: string; username: string | null } }
    | { kind: "self" | "none" | "ambiguous" };

/**
 * Whether `term` is one of the holder's own identifiers: the main address, any
 * address they added (proved or not - it is theirs either way), the username.
 * Compared lowercased and without a leading "@". A name is handled by the
 * lookup, because somebody else may share it.
 */
async function isOwnLogin(viewerId: string, term: string): Promise<boolean> {
    const me = await prisma.user.findUnique({
        where: { id: viewerId },
        select: { email: true, username: true, emails: { select: { email: true } } }
    });
    if (!me) return false;
    const lowered = term.toLowerCase();
    const handle = lowered.replace(/^@/, "");
    return (
        me.email.toLowerCase() === lowered ||
        (me.username !== null && me.username.toLowerCase() === handle) ||
        me.emails.some((one) => one.email.toLowerCase() === lowered)
    );
}

/**
 * Find the one account a typed identifier means.
 *
 * A username or an address is unique, so it answers on its own. A name is not,
 * which is why two people called the same thing is "ambiguous" rather than a
 * guess: the whole point of the field is to hand somebody your account, and
 * picking the wrong Ana Garcia is not a mistake anybody would catch by reading
 * the row back. The holder's own identifiers answer "self", whichever of them
 * was typed.
 *
 * The name is compared after the same normalization every name is stored
 * through, so "ana  garcia" finds the account written "Ana Garcia". By login
 * under the same rule as every people search, and by name only among accounts
 * the viewer may find - otherwise this would say whether an address or a full
 * name has an account here. A match carries only the name and handle, never
 * the address that was typed.
 */
export async function lookupSuccessor(
    viewerId: string,
    identifier: string
): Promise<SuccessorLookup> {
    const term = identifier.trim();
    if (!term) return { kind: "none" };
    if (await isOwnLogin(viewerId, term)) return { kind: "self" };

    const byLogin = await resolveNamedAccount({ id: viewerId }, term);
    if (byLogin) {
        if (byLogin.id === viewerId) return { kind: "self" };
        return {
            kind: "match",
            person: { userId: byLogin.id, name: byLogin.name, username: byLogin.username }
        };
    }

    const named = await prisma.user.findMany({
        where: { name: normalizePersonName(term) },
        select: { id: true, name: true, username: true },
        take: 20
    });
    const findable = await findableBy(
        viewerId,
        named.map((one) => one.id)
    );
    const others = named.filter((one) => one.id !== viewerId && findable.has(one.id));
    if (others.length > 1) return { kind: "ambiguous" };
    const only = others[0];
    if (only)
        return {
            kind: "match",
            person: { userId: only.id, name: only.name, username: only.username }
        };
    return { kind: named.some((one) => one.id === viewerId) ? "self" : "none" };
}

/** Whether a code may be minted to name this account: somebody else, and real.
 *  Checked before anything is sent, so a code is never spent on an add that
 *  cannot succeed. */
export async function canNameSuccessor(viewerId: string, candidateId: string): Promise<boolean> {
    if (!candidateId || candidateId === viewerId) return false;
    const row = await prisma.user.findUnique({ where: { id: candidateId }, select: { id: true } });
    return row !== null;
}

/** The sentence for a lookup that did not end in somebody else. */
function refusalFor(kind: "self" | "none" | "ambiguous"): string {
    if (kind === "self") return "Name somebody else - you cannot succeed yourself";
    if (kind === "ambiguous")
        return "More than one account has that name - use their username or email address";
    return "No account matches that username, name or email address";
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
    const found = await lookupSuccessor(userId, identifier);
    if (found.kind !== "match") throw new SuccessorError(refusalFor(found.kind));
    return nameSuccessor(userId, found.person.userId);
}

/** Write the designation for an account already resolved. The holder's own id
 *  is refused here, whatever identifier led to it. */
export async function nameSuccessor(userId: string, successorId: string): Promise<SuccessorView> {
    if (successorId === userId)
        throw new SuccessorError("Name somebody else - you cannot succeed yourself");

    const acknowledgedAt = new Date();
    await prisma.accountSuccessor.upsert({
        where: { userId },
        create: { userId, successorId, acknowledgedAt },
        update: { successorId, acknowledgedAt }
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

    // Found as the owner would find them: the owner is who answers for it.
    const person = await findPerson(org.ownerId, identifier);
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
