/**
 * What the outside world already knows about a sender.
 *
 * Two questions, asked of two services Polaris may already have configured: is
 * this address one that defrauds people or cannot receive mail at all (Dymo),
 * and is the domain behind it one the security engines have flagged
 * (VirusTotal). Both are billed per request, so both go through the platform's
 * one reputation cache (`lib/reputation`), which is keyed on the question rather
 * than on who asked it - so the same domain is bought once however many times
 * Polaris wants to know about it.
 *
 * **Nothing here decides whether a message arrives.** It is read by
 * `knowledgeFor` alongside what the mailbox already knows about the sender, and
 * what it answers is added to the local judgement as ordinary signals rather
 * than overriding it. Every path through it that cannot answer answers nothing:
 * a provider that is unconfigured, out of quota, slow or broken leaves the
 * filter with exactly the verdict it would have reached on its own, and the
 * caller catches whatever this throws.
 *
 * **Silence is not an accusation.** A provider that is not configured, is out of
 * quota, or has never heard of a domain contributes nothing at all - not a small
 * penalty. Most domains are unknown to VirusTotal, and treating "not famous" as
 * "suspicious" would flag every small business that ever wrote to anybody.
 */

import * as core from "@polaris/core";
import { lookupDomain } from "@/lib/integrations/virustotal";
import { MAIL_DENY_RULES, verifyEmail } from "@/lib/integrations/dymo";
import { knownReputation, rememberReputation } from "@/lib/reputation";
import { getIntegrationSecret, getIntegrationState } from "@/lib/integration-service";

/** What a lookup adds to a message's score. */
export interface ReputationFinding {
    readonly id: string;
    readonly score: number;
    readonly reason: string;
}

/**
 * How much an outside opinion is worth.
 *
 * A flagged domain is the heaviest single thing in the whole filter that is not
 * an executable attachment, because it is not a guess about wording: engines
 * that watch for phishing have seen this domain hosting some. A clean answer is
 * worth a little in the other direction and no more - being unflagged is the
 * normal state of every domain on the internet, including the ones registered
 * this morning to send this message.
 */
const WEIGHTS = {
    domainFlagged: 30,
    domainClean: -5,
    addressFlagged: 22,
    addressClean: -4
} as const;

/** The provider names the cache stores these under. Named here rather than at
 *  each call so one string decides what a remembered answer is filed under. */
const DYMO = "dymo";
const VIRUSTOTAL = "virustotal";

/**
 * How long the filter will wait for an outside opinion before going without it.
 *
 * This runs once per arriving message inside the sync, so the cost of a provider
 * having a bad afternoon is paid on every message in the pass. One of the two
 * SDKs sets no deadline of its own, and a request with no deadline is the one
 * that stops a mailbox syncing. Four seconds is far longer than either takes
 * when it is working, and short enough that a thousand messages behind a broken
 * provider is a slow sync rather than a stopped one.
 */
const MOST_WAIT_MS = 4000;

/**
 * Ask about one sender, using what is already known wherever possible.
 *
 * Answers an empty list when neither provider is configured, which is the normal
 * case and costs one settings read. Also answers an empty list when a provider
 * is simply taking too long: what it had to say was never worth delaying
 * somebody's mail for.
 */
export async function senderReputation(fromAddress: string): Promise<ReputationFinding[]> {
    const address = fromAddress.trim().toLowerCase();
    if (!address.includes("@")) return [];
    const domain = core.baseDomain(core.domainOf(address)) || core.domainOf(address);
    if (!domain) return [];

    const findings: ReputationFinding[] = [];
    const [fromDomain, fromAddressCheck] = await inTime(
        Promise.all([domainOpinion(domain), addressOpinion(address)])
    );
    if (fromDomain) findings.push(fromDomain);
    if (fromAddressCheck) findings.push(fromAddressCheck);
    return findings;
}

/** The pair of opinions, or neither of them once the deadline passes. The work
 *  is not cancelled - what it writes to the cache is still worth having for the
 *  next message from that sender. */
function inTime(
    work: Promise<[ReputationFinding | null, ReputationFinding | null]>
): Promise<[ReputationFinding | null, ReputationFinding | null]> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve([null, null]), MOST_WAIT_MS);
        // Never holds the process open on its own account: this is a deadline on
        // work somebody is already waiting for.
        timer.unref?.();
        void work.then(
            (answer) => {
                clearTimeout(timer);
                resolve(answer);
            },
            () => {
                clearTimeout(timer);
                resolve([null, null]);
            }
        );
    });
}

/**
 * What the security engines say about the domain, cached.
 *
 * The integration is asked about before the cache is, so turning VirusTotal off
 * stops it counting straight away rather than a fortnight from now when the last
 * remembered answer expires. It is also the cheaper order in the case that
 * happens on nearly every message: nothing configured, one settings read, done.
 */
async function domainOpinion(domain: string): Promise<ReputationFinding | null> {
    const state = await getIntegrationState(VIRUSTOTAL);
    if (!state?.enabled) return null;

    const known = await knownReputation("domain", domain, VIRUSTOTAL);
    if (known) return fromVerdict("domain", domain, known);

    const apiKey = await getIntegrationSecret(VIRUSTOTAL);
    if (!apiKey) return null;

    const verdict = await lookupDomain(apiKey, domain);
    // An error or an unknown domain is remembered as nothing at all: writing it
    // down as clean would keep Polaris from asking again once the engines DO
    // know something, and writing it down as bad would be an accusation made by
    // a timeout.
    if (verdict.kind === "error" || verdict.kind === "unknown") return null;

    const flagged = verdict.kind === "malicious" || verdict.kind === "suspicious";
    const remembered = {
        allow: !flagged,
        reason: flagged
            ? `${verdict.malicious + verdict.suspicious} security engines flag this domain`
            : null
    };
    await rememberReputation("domain", domain, VIRUSTOTAL, remembered);
    return fromVerdict("domain", domain, remembered);
}

/** What the address itself is, cached. Asked in the same order as the domain,
 *  and for the same two reasons. */
async function addressOpinion(address: string): Promise<ReputationFinding | null> {
    const state = await getIntegrationState(DYMO);
    if (!state?.enabled) return null;

    const known = await knownReputation("email", address, DYMO, MAIL_DENY_RULES);
    if (known) return fromVerdict("email", address, known);

    const apiKey = await getIntegrationSecret(DYMO);
    if (!apiKey) return null;

    try {
        const { allow, reasons } = await verifyEmail(apiKey, address);
        const remembered = {
            allow,
            reason: allow ? null : readable(reasons)
        };
        await rememberReputation("email", address, DYMO, remembered, MAIL_DENY_RULES);
        return fromVerdict("email", address, remembered);
    } catch {
        // A provider that failed has no opinion. Nothing is written down, so the
        // next message asks again rather than inheriting a silence.
        return null;
    }
}

/** One remembered answer, as something the filter can add up. */
function fromVerdict(
    kind: "domain" | "email",
    subject: string,
    verdict: { allow: boolean; reason: string | null }
): ReputationFinding {
    if (kind === "domain") {
        return verdict.allow
            ? {
                  id: "domain_reputation_clean",
                  score: WEIGHTS.domainClean,
                  reason: `${subject} is not flagged by the security engines`
              }
            : {
                  id: "domain_reputation_flagged",
                  score: WEIGHTS.domainFlagged,
                  reason: verdict.reason ?? `${subject} is flagged by security engines`
              };
    }
    return verdict.allow
        ? {
              id: "address_reputation_clean",
              score: WEIGHTS.addressClean,
              reason: "The sending address checks out"
          }
        : {
              id: "address_reputation_flagged",
              score: WEIGHTS.addressFlagged,
              reason: verdict.reason ?? "The sending address is flagged"
          };
}

/** The provider's rule names, as a sentence somebody can act on. A reader
 *  should not have to know what `NO_MX_RECORDS` means to understand that the
 *  address it names cannot receive a reply. */
function readable(reasons: readonly string[]): string {
    const said: Record<string, string> = {
        FRAUD: "this address is known for fraud",
        INVALID: "this address cannot exist",
        NO_MX_RECORDS: "its domain cannot receive mail at all",
        HIGH_RISK_SCORE: "this address scores as high risk"
    };
    const first = reasons.find((one) => one in said);
    return first
        ? (said[first] ?? "the sending address is flagged")
        : "the sending address is flagged";
}
