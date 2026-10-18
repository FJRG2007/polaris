/**
 * What a Polaris account already knows about the person who owns it, in the
 * shape of a vault identity.
 *
 * Read when somebody makes an identity "from my account", so the sign-up forms
 * the extension fills start from the name, addresses and phone they already
 * gave Polaris instead of a blank form. It goes to that person's own browser,
 * which encrypts it like any other item: nothing here is stored.
 */

import { prisma } from "@polaris/db";

/** The fields an identity can be started from. Empty strings where Polaris has
 *  nothing, because the form draws every field either way. */
export interface AccountIdentity {
    firstName: string;
    lastName: string;
    company: string;
    phone: string;
    username: string;
    /** Every address on the account, the sign-in one first. Somebody picks one
     *  for the identity or types another. */
    emails: string[];
}

/** The account's rows, as the reader below selects them. */
export interface AccountFacts {
    name: string;
    firstName: string | null;
    lastName: string | null;
    email: string;
    username: string | null;
    company: string | null;
    phone: string | null;
    emails: readonly string[];
}

/**
 * Turn an account into an identity.
 *
 * The two halves of the name are used when the account has them; a display
 * name is split at its first space otherwise, which is a guess the form shows
 * before anything is saved. Addresses are deduplicated without regard to case.
 */
export function identityFromAccount(facts: AccountFacts): AccountIdentity {
    const [given = "", ...rest] = facts.name.trim().split(/\s+/);
    const halves = Boolean(facts.firstName?.trim() || facts.lastName?.trim());
    const seen = new Set<string>();
    const emails: string[] = [];
    for (const raw of [facts.email, ...facts.emails]) {
        const email = raw.trim();
        if (email === "" || seen.has(email.toLowerCase())) continue;
        seen.add(email.toLowerCase());
        emails.push(email);
    }
    return {
        firstName: (halves ? (facts.firstName ?? "") : given).trim(),
        lastName: (halves ? (facts.lastName ?? "") : rest.join(" ")).trim(),
        company: facts.company?.trim() ?? "",
        phone: facts.phone?.trim() ?? "",
        username: facts.username?.trim() ?? "",
        emails
    };
}

/** The identity for one account, or null when the account is gone. */
export async function accountIdentity(userId: string): Promise<AccountIdentity | null> {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            name: true,
            firstName: true,
            lastName: true,
            email: true,
            username: true,
            company: true
        }
    });
    if (!user) return null;
    const [emails, phone] = await Promise.all([
        prisma.userEmail.findMany({
            where: { userId },
            select: { email: true },
            orderBy: { createdAt: "asc" },
            take: 50
        }),
        prisma.userPhone.findUnique({ where: { userId }, select: { phone: true } })
    ]);
    return identityFromAccount({
        ...user,
        phone: phone?.phone ?? null,
        emails: emails.map((row) => row.email)
    });
}
