/**
 * What a provider said about something, remembered once for the whole platform.
 *
 * Polaris asks two outside services about the same handful of things from
 * several places at once: the firewall asks about an address, a share link asks
 * about its visitor, and the mail filter asks about the address a message came
 * from and the domain behind it. Every one of those is billed per request, and
 * without this every one of them was buying answers Polaris already had.
 *
 * So the key is the QUESTION rather than the asker: a kind, the value, and the
 * provider that answered. A domain the mail filter paid to look up answers the
 * firewall's next question about it, and the other way round. It also means an
 * administrator has one place to clear rather than one per feature - and one
 * fact about a domain, rather than Polaris believing two different things about
 * it depending on which screen is asking.
 *
 * **Nothing here decides anything.** What is stored is what the provider said,
 * not what Polaris did about it, so a rule change is applied to a remembered
 * answer rather than needing the answer bought again. The one exception is
 * `rules`: a verdict reached under a different set of deny conditions is an
 * answer to a different question, so it is not reused.
 */

import { prisma } from "@polaris/db";

/** What can be asked about. */
export const REPUTATION_KINDS = ["ip", "domain", "email"] as const;
export type ReputationKind = (typeof REPUTATION_KINDS)[number];

/**
 * How long an answer stands, by what it is about.
 *
 * An address changes hands: a home connection is a different household every
 * few months and a hosting address is a different customer every few days, so
 * those are asked again daily. A domain and an address at one are the opposite -
 * a domain registered for a campaign is bad for its whole short life, and a real
 * company's domain does not become fraudulent on a Tuesday. Fifteen days there,
 * which is what somebody asked for and is also roughly the point at which a
 * throwaway domain has stopped sending anyway.
 */
const TTL_MS: Readonly<Record<ReputationKind, number>> = {
    ip: 24 * 60 * 60 * 1000,
    domain: 15 * 24 * 60 * 60 * 1000,
    email: 15 * 24 * 60 * 60 * 1000
};

/** A flagged verdict is held for less than a clean one, so something that was
 *  cleaned up is not held against it for a fortnight. */
const FLAGGED_TTL_MS: Readonly<Record<ReputationKind, number>> = {
    ip: 6 * 60 * 60 * 1000,
    domain: 3 * 24 * 60 * 60 * 1000,
    email: 3 * 24 * 60 * 60 * 1000
};

/** Past this an answer is history nobody reads, and the subject will have been
 *  asked about again long before. */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface Verdict {
    readonly allow: boolean;
    /** Why, in the provider's own words, or null for a clean answer. */
    readonly reason: string | null;
}

/**
 * The value, in the one form it is stored under.
 *
 * Case is meaningless in all three, and an address's `+tag` is a label its owner
 * chose rather than a different mailbox - so `Someone+news@Example.COM` and
 * `someone@example.com` are one question and get one answer.
 */
export function normalizeSubject(kind: ReputationKind, value: string): string {
    const cleaned = value.trim().toLowerCase();
    if (kind !== "email") return cleaned;
    const at = cleaned.lastIndexOf("@");
    if (at < 1) return cleaned;
    const local = cleaned.slice(0, at).split("+")[0] ?? "";
    return `${local}@${cleaned.slice(at + 1)}`;
}

/** The conditions a verdict was reached under, as one comparable string. Sorted,
 *  so the same set written in another order is the same question. */
export function rulesKey(deny: readonly string[]): string {
    return [...deny]
        .map((rule) => rule.trim().toUpperCase())
        .sort()
        .join(",");
}

/**
 * What is already known, or null when there is nothing worth having - never
 * asked, asked too long ago, or asked under different conditions.
 */
export async function knownReputation(
    kind: ReputationKind,
    value: string,
    provider: string,
    deny: readonly string[] = []
): Promise<Verdict | null> {
    const subject = normalizeSubject(kind, value);
    if (!subject) return null;
    const row = await prisma.subjectReputation.findUnique({
        where: { kind_subject_provider: { kind, subject, provider } }
    });
    if (!row || row.rules !== rulesKey(deny)) return null;
    const age = Date.now() - row.checkedAt.getTime();
    if (age > (row.allow ? TTL_MS[kind] : FLAGGED_TTL_MS[kind])) return null;
    return { allow: row.allow, reason: row.reason };
}

/** Write down what a provider said, whatever it said. The clean answers are the
 *  point: they are the ones that were being bought over and over. */
export async function rememberReputation(
    kind: ReputationKind,
    value: string,
    provider: string,
    verdict: Verdict,
    deny: readonly string[] = []
): Promise<void> {
    const subject = normalizeSubject(kind, value);
    if (!subject) return;
    const row = {
        allow: verdict.allow,
        reason: verdict.reason,
        rules: rulesKey(deny),
        checkedAt: new Date()
    };
    await prisma.subjectReputation.upsert({
        where: { kind_subject_provider: { kind, subject, provider } },
        create: { kind, subject, provider, ...row },
        update: row
    });
}

/**
 * Forget what is known, so the next question is asked again.
 *
 * The administrator's control, and it is deliberately three different sizes: one
 * subject, everything of one kind, or the lot. "Look at every domain again"
 * should not throw away the addresses the firewall is in the middle of sweeping,
 * and a single bad answer about one sender should not cost a full re-scan of
 * everything.
 */
export async function forgetReputation(
    scope: { kind?: ReputationKind; value?: string; provider?: string } = {}
): Promise<number> {
    const { count } = await prisma.subjectReputation.deleteMany({
        where: {
            ...(scope.kind ? { kind: scope.kind } : {}),
            ...(scope.value && scope.kind
                ? { subject: normalizeSubject(scope.kind, scope.value) }
                : {}),
            ...(scope.provider ? { provider: scope.provider } : {})
        }
    });
    return count;
}

/** What the cache holds, for the screen that has to say so. */
export async function reputationCounts(): Promise<Record<ReputationKind, number>> {
    const rows = await prisma.subjectReputation.groupBy({ by: ["kind"], _count: { kind: true } });
    const counts = { ip: 0, domain: 0, email: 0 };
    for (const row of rows) {
        if (row.kind in counts) counts[row.kind as ReputationKind] = row._count.kind;
    }
    return counts;
}

/** Drop what nobody will read again. Runs with the firewall's housekeeping. */
export async function pruneReputation(): Promise<void> {
    await prisma.subjectReputation.deleteMany({
        where: { checkedAt: { lt: new Date(Date.now() - RETENTION_MS) } }
    });
}
