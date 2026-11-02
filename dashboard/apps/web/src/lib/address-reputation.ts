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
 *
 * Answers live in the platform's one cache (`lib/reputation`), keyed per provider.
 * The older table held one row per address, so with two providers connected each
 * overwrote the other's answer and both were asked again on every pass. It is only
 * drained now.
 */

import { prisma } from "@polaris/db";
import { knownReputation, rememberReputation } from "@/lib/reputation";

export interface AddressVerdict {
    readonly allow: boolean;
    readonly reason: string | null;
}

/**
 * The remembered answer for this address, or null when there is none worth
 * having - never asked, asked too long ago, or asked under different rules.
 */
export function rememberedVerdict(
    ip: string,
    provider: string,
    deny: readonly string[]
): Promise<AddressVerdict | null> {
    return knownReputation("ip", ip, provider, deny);
}

/** Write down what a provider said, whatever it said. The clean answers are the
 *  point: they are the ones that were being bought over and over. */
export function rememberVerdict(
    ip: string,
    provider: string,
    deny: readonly string[],
    verdict: AddressVerdict
): Promise<void> {
    return rememberReputation("ip", ip, provider, verdict, deny);
}

/** Empty the older table as its rows age out. */
export async function pruneAddressReputation(): Promise<void> {
    await prisma.addressReputation.deleteMany({
        where: { checkedAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }
    });
}
