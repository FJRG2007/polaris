/**
 * What the outside world already knows about a sender.
 *
 * Two questions, asked of two services Polaris may already have configured: is
 * this address one that defrauds people or cannot receive mail at all (Dymo),
 * and is the domain behind it one the security engines have flagged
 * (VirusTotal). Both are billed per request, so both go through the platform's
 * one reputation cache - which the firewall reads and writes too, so a domain
 * looked up here is a domain the firewall does not pay to look up again.
 *
 * **Nothing here is on the path of a message arriving.** The filter's own
 * judgement is local, immediate and complete; this is asked afterwards, and what
 * it finds adjusts a score that already exists. That ordering is deliberate: a
 * provider being slow, rate-limited or unconfigured must never be the reason
 * somebody's mail is late, and none of these answers is worth waiting for.
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

/** The provider names the cache stores these under. Shared with the firewall,
 *  which is the point of naming them here rather than at each call. */
const DYMO = "dymo";
const VIRUSTOTAL = "virustotal";

/**
 * Ask about one sender, using what is already known wherever possible.
 *
 * Answers an empty list when neither provider is configured, which is the normal
 * case and costs one settings read.
 */
export async function senderReputation(fromAddress: string): Promise<ReputationFinding[]> {
    const address = fromAddress.trim().toLowerCase();
    if (!address.includes("@")) return [];
    const domain = core.baseDomain(core.domainOf(address)) || core.domainOf(address);
    if (!domain) return [];

    const findings: ReputationFinding[] = [];
    const [fromDomain, fromAddressCheck] = await Promise.all([
        domainOpinion(domain),
        addressOpinion(address)
    ]);
    if (fromDomain) findings.push(fromDomain);
    if (fromAddressCheck) findings.push(fromAddressCheck);
    return findings;
}

/** What the security engines say about the domain, cached. */
async function domainOpinion(domain: string): Promise<ReputationFinding | null> {
    const known = await knownReputation("domain", domain, VIRUSTOTAL);
    if (known) return fromVerdict("domain", domain, known);

    const state = await getIntegrationState(VIRUSTOTAL);
    if (!state?.enabled) return null;
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

/** What the address itself is, cached. */
async function addressOpinion(address: string): Promise<ReputationFinding | null> {
    const known = await knownReputation("email", address, DYMO, MAIL_DENY_RULES);
    if (known) return fromVerdict("email", address, known);

    const state = await getIntegrationState(DYMO);
    if (!state?.enabled) return null;
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
    return first ? said[first] ?? "the sending address is flagged" : "the sending address is flagged";
}
