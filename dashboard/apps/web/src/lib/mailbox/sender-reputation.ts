/**
 * What the outside world already knows about a sender.
 *
 * Three questions, asked of two services Polaris may already have configured:
 * is the DOMAIN a message came from one that defrauds people, is the ADDRESS at
 * it one that defrauds people or cannot receive mail at all (Dymo, in that
 * order - the domain's answer covers every address that will ever write from
 * it), and is the domain one the security engines have flagged (VirusTotal).
 * Every one of them is billed per request, so all of them go through the one
 * reputation cache (`lib/reputation`), which is keyed on the question rather
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
import { knownReputation, rememberReputation } from "@/lib/reputation";
import { MAIL_DENY_RULES, verifyDomain, verifyEmail } from "@/lib/integrations/dymo";
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
    addressClean: -4,
    /**
     * Named as fraud, by a provider that has the address or the domain on file
     * as defrauding people.
     *
     * The one outside opinion that is a verdict rather than evidence, and it is
     * scored exactly at the junk line so it is one on its own - the same weight
     * the local filter gives a credential phish. It is deliberately not higher:
     * a mailbox that has written to this sender is worth more than this and
     * should be, because the person who corresponds with somebody knows
     * something the provider does not.
     */
    fraud: core.SPAM_THRESHOLDS.junk
} as const;

/**
 * The exact sentence a fraud verdict is written down as.
 *
 * The cache stores what the provider said in the words the reader sees, not the
 * rule name behind it, so this constant is what a remembered answer is
 * recognised by on the way back out. Change it and a remembered fraud verdict
 * quietly demotes itself to the ordinary flagged weight, which is why it is one
 * constant rather than a sentence typed twice.
 */
const FRAUD_SAID = "this address is known for fraud";

/** What a fraudulent domain is written down as, for the same reason. */
const DOMAIN_FRAUD_SAID = "this domain is known for fraud";

/** What is asked about a domain, as the cache records the question. Held apart
 *  from `MAIL_DENY_RULES` because it is a different question with a different
 *  answer, and a cache that could not tell them apart would answer one with the
 *  other. */
const DOMAIN_RULES: readonly string[] = ["FRAUD"];

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

    const findings = await inTime(
        Promise.all([domainOpinion(domain), senderIsFraud(address, domain)])
    );
    return findings.filter((one): one is ReputationFinding => Boolean(one));
}

/** The opinions, or none of them once the deadline passes. The work is not
 *  cancelled - what it writes to the cache is still worth having for the next
 *  message from that sender. */
function inTime(
    work: Promise<(ReputationFinding | null)[]>
): Promise<(ReputationFinding | null)[]> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve([]), MOST_WAIT_MS);
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
                resolve([]);
            }
        );
    });
}

/**
 * What the address-reputation provider has on this sender - the domain first,
 * then the address.
 *
 * That order is the whole design. A campaign registers one domain and writes
 * from a different address at it every hour, so an answer about the domain is
 * the one that is still worth something an hour later and the one the next
 * thousand messages read out of the cache for nothing. Once it comes back as
 * fraudulent the address is not bought at all: the question has been answered,
 * and the second lookup would be a second charge for it.
 *
 * Both halves answer nothing when the provider is switched off, holds no key,
 * or fails - which between them is nearly every deployment, since the provider
 * is something an operator turns on in Integrations rather than something
 * Polaris ships with.
 */
async function senderIsFraud(address: string, domain: string): Promise<ReputationFinding | null> {
    const state = await getIntegrationState(DYMO);
    if (!state?.enabled) return null;
    return (await domainIsFraud(domain)) ?? (await addressOpinion(address));
}

/** Whether the provider holds the sending domain itself as fraudulent. A clean
 *  answer contributes nothing: an unflagged domain is the normal state of every
 *  domain there is, including the one registered this morning. */
async function domainIsFraud(domain: string): Promise<ReputationFinding | null> {
    const said = `The domain it came from, ${domain}, is known for defrauding people`;
    const known = await knownReputation("domain", domain, DYMO, DOMAIN_RULES);
    if (known) return known.allow ? null : { id: "domain_fraud", score: WEIGHTS.fraud, reason: said };

    const apiKey = await getIntegrationSecret(DYMO);
    if (!apiKey) return null;
    try {
        const { fraud } = await verifyDomain(apiKey, domain);
        await rememberReputation(
            "domain",
            domain,
            DYMO,
            { allow: !fraud, reason: fraud ? DOMAIN_FRAUD_SAID : null },
            DOMAIN_RULES
        );
        return fraud ? { id: "domain_fraud", score: WEIGHTS.fraud, reason: said } : null;
    } catch {
        // A provider that failed has no opinion, and nothing is written down.
        return null;
    }
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

/** What the address itself is, cached. Reached only once the domain behind it
 *  has answered that it is not already a fraud, because that answer would have
 *  covered this one. */
async function addressOpinion(address: string): Promise<ReputationFinding | null> {
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
    if (verdict.allow) {
        return {
            id: "address_reputation_clean",
            score: WEIGHTS.addressClean,
            reason: "The sending address checks out"
        };
    }
    // Fraud is the one answer that is a verdict rather than evidence, and it is
    // recognised by the sentence it was written down as - the cache keeps what
    // was said, not the rule name it came from.
    if (verdict.reason === FRAUD_SAID) {
        return {
            id: "address_fraud",
            score: WEIGHTS.fraud,
            reason: `${subject} is known for defrauding people`
        };
    }
    return {
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
        FRAUD: FRAUD_SAID,
        INVALID: "this address cannot exist",
        NO_MX_RECORDS: "its domain cannot receive mail at all",
        HIGH_RISK_SCORE: "this address scores as high risk"
    };
    const first = reasons.find((one) => one in said);
    return first
        ? (said[first] ?? "the sending address is flagged")
        : "the sending address is flagged";
}
