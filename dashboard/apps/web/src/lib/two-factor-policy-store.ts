/**
 * Where an account's second-factor policy and its usual countries are kept: the
 * account's own security row. Reads are total - an account with no row has the
 * default policy and no history, which is every account before this existed.
 */

import { prisma } from "@polaris/db";
import { parsePolicy, rememberCountry, type TwoFactorPolicy } from "@/lib/two-factor-policy";

export async function loadTwoFactorPolicy(userId: string): Promise<TwoFactorPolicy> {
    const row = await prisma.userSecurity
        .findUnique({ where: { userId }, select: { twoFactorRefused: true, twoFactorStrictness: true } })
        .catch(() => null);
    return parsePolicy(row);
}

export async function saveTwoFactorPolicy(userId: string, policy: TwoFactorPolicy): Promise<void> {
    const data = { twoFactorRefused: JSON.stringify(policy.refused), twoFactorStrictness: policy.strictness };
    await prisma.userSecurity.upsert({ where: { userId }, create: { userId, ...data }, update: data });
}

/**
 * The countries this account usually signs in from.
 *
 * The stored list is written by every finished sign-in. An account that predates
 * it has none, so the countries its open sessions were seen in stand in - one
 * bounded query, newest first. Nothing at all means no history, which is never
 * unusual.
 */
export async function usualSignInCountries(userId: string, excludeSessionId: string): Promise<string[]> {
    const row = await prisma.userSecurity
        .findUnique({ where: { userId }, select: { signInCountries: true } })
        .catch(() => null);
    if (row && row.signInCountries.length > 0) return row.signInCountries;
    const states = await prisma.sessionState
        .findMany({
            where: { userId, sessionId: { not: excludeSessionId }, country: { not: null }, stepUp: null },
            orderBy: { lastSeenAt: "desc" },
            take: 50,
            select: { country: true }
        })
        .catch(() => []);
    return Array.from(new Set(states.map((state) => state.country!.toUpperCase())));
}

/** Add a finished sign-in's country to the account's usual ones. Never fails a
 *  sign-in: a history not written costs one extra question later, no more. */
export async function rememberSignInCountry(userId: string, country: string | null | undefined): Promise<void> {
    if (!country) return;
    try {
        const row = await prisma.userSecurity.findUnique({ where: { userId }, select: { signInCountries: true } });
        const next = rememberCountry(row?.signInCountries ?? [], country);
        await prisma.userSecurity.upsert({
            where: { userId },
            create: { userId, signInCountries: next },
            update: { signInCountries: next }
        });
    } catch (error) {
        console.error("sign-in country not recorded:", error);
    }
}
