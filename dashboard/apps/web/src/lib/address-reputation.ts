/**
 * What a reputation provider said about an address, remembered.
 *
 * One cache in front of every provider lookup Polaris makes, because both places
 * that ask were paying per request for answers they already had.
 *
 * The firewall's sweep asked about the addresses in the last few megabytes of the
 * access log, skipping the ones it had already banned - which meant an address
 * that came back **clean** was skipped by nothing, because a clean answer was
 * never written down. The sweep runs every thirty seconds over a log window that
 * barely changes, so the same ordinary visitors were looked up twice a minute
 * for as long as they stayed in it: twenty-five an pass, seventy-two thousand a
 * day, all of them questions that had been answered already.
 *
 * The other place is a share link. Every visit to one asked the provider about
 * the visitor, so a crawler working through a public link paid for a lookup per
 * hit.
 *
 * A verdict is kept against the deny rules it was reached under. Changing what
 * counts as bad is a different question, so it is asked again rather than
 * answered from a cache that predates the change.
 */

import { prisma } from "@polaris/db";

/**
 * How long an answer stands.
 *
 * A day for a clean address: reputation does change, and a host that becomes a
 * proxy tomorrow is worth catching, but not at the price of asking about the
 * same visitor every thirty seconds. Six hours for a flagged one, which is the
 * same window the ban it produced is held for.
 */
const CLEAN_TTL_MS = 24 * 60 * 60 * 1000;
const FLAGGED_TTL_MS = 6 * 60 * 60 * 1000;

/** How long a verdict is kept at all. Past this it is history nobody reads, and
 *  the address will be asked about again long before it. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface AddressVerdict {
    readonly allow: boolean;
    readonly reason: string | null;
}

/** The rules a verdict was reached under, as one comparable string. Sorted, so
 *  the same set written in a different order is the same question. */
export function rulesKey(deny: readonly string[]): string {
    return [...deny].map((rule) => rule.trim().toUpperCase()).sort().join(",");
}

/**
 * The remembered answer for this address, or null when there is none worth
 * having - never asked, asked too long ago, or asked under different rules.
 */
export async function rememberedVerdict(
    ip: string,
    provider: string,
    deny: readonly string[]
): Promise<AddressVerdict | null> {
    const row = await prisma.addressReputation.findUnique({ where: { ip } });
    if (!row || row.provider !== provider || row.rules !== rulesKey(deny)) return null;
    const age = Date.now() - row.checkedAt.getTime();
    if (age > (row.allow ? CLEAN_TTL_MS : FLAGGED_TTL_MS)) return null;
    return { allow: row.allow, reason: row.reason };
}

/** Write down what a provider said, whatever it said. The clean answers are the
 *  point: they are the ones that were being bought over and over. */
export async function rememberVerdict(
    ip: string,
    provider: string,
    deny: readonly string[],
    verdict: AddressVerdict
): Promise<void> {
    const row = {
        provider,
        allow: verdict.allow,
        reason: verdict.reason,
        rules: rulesKey(deny),
        checkedAt: new Date()
    };
    await prisma.addressReputation.upsert({ where: { ip }, create: { ip, ...row }, update: row });
}

/** Drop verdicts nobody will read again. Runs with the firewall's other
 *  housekeeping. */
export async function pruneAddressReputation(): Promise<void> {
    await prisma.addressReputation.deleteMany({
        where: { checkedAt: { lt: new Date(Date.now() - RETENTION_MS) } }
    });
}

/** How many addresses have a remembered verdict, for the screen that has to say
 *  what the cache is doing. */
export async function rememberedCount(): Promise<number> {
    return prisma.addressReputation.count();
}
