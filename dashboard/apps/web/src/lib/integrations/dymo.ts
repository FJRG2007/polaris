/**
 * Thin wrapper over the official Dymo SDK for the one call Polaris makes: verify a
 * visitor IP against a set of deny rules. Kept isolated so the rest of the app
 * depends on a plain result shape, not the SDK.
 */

import { z } from "zod";
import DymoAPI, { type NegativeEmailRules, type NegativeIPRules } from "dymo-api";

/**
 * What an answer has to look like before any of it is believed.
 *
 * The SDK's types describe what the service is documented to return, not what
 * arrived: this is a third party's JSON reaching code that decides where
 * somebody's mail goes, and a missing field read as `undefined` is how a
 * verdict turns into `false` and a message is accused by a parse error. Every
 * shape below is the minimum this file actually reads, and anything else in the
 * answer is left alone.
 */
const VERDICT = z.object({
    allow: z.boolean(),
    reasons: z.array(z.string()).optional()
});

/** The raw analysis, of which only the fraud flag is read. Loose everywhere
 *  else on purpose - the service adds fields, and a stricter schema here would
 *  turn a new one into a lookup that answers nothing. */
const DOMAIN_ANALYSIS = z.object({
    domain: z.object({ valid: z.boolean().optional(), fraud: z.boolean().optional() }).optional()
});

/** The IP verdict with the part of the analysis that says the address is shared:
 *  `vpn`, `proxy` and `mobile` (a carrier's NAT), as the SDK's
 *  `DataIPValidationAnalysis` types them. Loose for the same reason as above. */
const IP_VERDICT = VERDICT.extend({
    response: z
        .object({
            vpn: z.boolean().optional(),
            proxy: z.boolean().optional(),
            mobile: z.boolean().optional()
        })
        .optional()
});

/** Verdicts that describe how an address has been used rather than what it is. On a
 *  shared address they are about everybody else on it. */
const BEHAVIOURAL_IP_RULES = new Set(["FRAUD", "HIGH_RISK_SCORE"]);

/**
 * Settle an IP verdict, treating a shared address softly.
 *
 * A VPN exit, WARP, a private relay or a carrier's NAT carries thousands of people,
 * and a fraud or risk verdict on it is the sum of what they did. Banning on it turned
 * away a new member accepting an invite. So on an address the analysis calls a VPN,
 * a proxy or mobile, those two verdicts are dropped. The operator's own choice to
 * deny VPN or PROXY traffic still stands, because that is a verdict about what the
 * address is, and it is the one they asked for. Pure, so it can be tested without
 * the network.
 */
export function settleIpVerdict(answer: z.infer<typeof IP_VERDICT>): {
    allow: boolean;
    reasons: string[];
    shared: boolean;
} {
    const reasons = answer.reasons ?? [];
    const shared =
        answer.response?.vpn === true ||
        answer.response?.proxy === true ||
        answer.response?.mobile === true;
    if (answer.allow || !shared) return { allow: answer.allow, reasons, shared };
    const kept = reasons.filter((reason) => !BEHAVIOURAL_IP_RULES.has(reason));
    // Nothing behavioural to drop: whatever refused it is not this function's to undo.
    if (kept.length === reasons.length) return { allow: false, reasons, shared };
    return { allow: kept.length === 0, reasons: kept, shared };
}

/** Verify an IP; `allow` is false when it matches any of the `deny` conditions,
 *  with a shared address treated as `settleIpVerdict` describes. */
export async function verifyIp(
    apiKey: string,
    ip: string,
    deny: string[]
): Promise<{ allow: boolean; reasons: string[] }> {
    const client = new DymoAPI({ apiKey });
    const answer = IP_VERDICT.parse(
        await client.isValidIP(ip, { deny: deny as NegativeIPRules[] })
    );
    const { allow, reasons } = settleIpVerdict(answer);
    return { allow, reasons };
}

/**
 * Verify an email address; `allow` is false when it matches any deny condition.
 *
 * The conditions are the SDK's own, and which of them Polaris asks about is a
 * decision rather than a list: `NO_REPLY_EMAIL`, `ROLE_ACCOUNT`, `PERSONAL_EMAIL`
 * and `CORPORATE_EMAIL` describe perfectly ordinary senders - almost every
 * receipt anybody gets is from a no-reply role account - and denying on them
 * would flag the legitimate half of a mailbox. What is asked about is what
 * actually distinguishes a sender worth worrying about: outright fraud, an
 * address that cannot exist, a domain with nowhere to deliver, and a risk score
 * the provider has already formed.
 */
export const MAIL_DENY_RULES: readonly NegativeEmailRules[] = [
    "FRAUD",
    "INVALID",
    "NO_MX_RECORDS",
    "HIGH_RISK_SCORE"
];

export async function verifyEmail(
    apiKey: string,
    email: string,
    deny: readonly NegativeEmailRules[] = MAIL_DENY_RULES
): Promise<{ allow: boolean; reasons: string[] }> {
    const client = new DymoAPI({ apiKey });
    const answer = VERDICT.parse(await client.isValidEmail(email, { deny: [...deny] }));
    return { allow: answer.allow, reasons: answer.reasons ?? [] };
}

/**
 * Whether the provider holds the DOMAIN itself as fraudulent.
 *
 * Asked separately from the address because it is the half that is worth
 * remembering: a campaign registers one domain and sends from a different
 * address at it every hour, so an answer about the address is spent the moment
 * it is bought and an answer about the domain covers everything that will ever
 * write from it.
 *
 * Only `fraud` is read. The rest of that analysis describes perfectly ordinary
 * domains - a free subdomain, an unusual ending, no MX records - and none of
 * them is a reason to file somebody's mail away.
 */
export async function verifyDomain(apiKey: string, domain: string): Promise<{ fraud: boolean }> {
    const client = new DymoAPI({ apiKey });
    const answer = DOMAIN_ANALYSIS.parse(await client.isValidDataRaw({ domain }));
    return { fraud: answer.domain?.fraud === true };
}

/**
 * Whether a web address is one Dymo knows to be fraudulent.
 *
 * Asks only for the base verdict, with no plugins: each plugin is a further
 * check the account is billed for, and the question chat asks is the narrow one
 * of whether the page is a known scam.
 */
export async function verifyUrl(apiKey: string, url: string): Promise<{ fraud: boolean }> {
    const client = new DymoAPI({ apiKey });
    const result = await client.isValidDataRaw({ url });
    return { fraud: result.url?.fraud === true };
}

/** The domain analysis with the NSFW plugin's answer, of which only the two
 *  verdicts are read. Loose for the same reason as `DOMAIN_ANALYSIS`. */
const DOMAIN_REPUTATION = z.object({
    domain: z
        .object({
            fraud: z.boolean().optional(),
            plugins: z.object({ nsfw: z.boolean().optional() }).partial().optional()
        })
        .optional()
});

/**
 * What Dymo says about a domain, for the network filter: its fraud verdict and,
 * when `adult` is asked for, the NSFW plugin's. The plugin is asked only when
 * the operator blocks adult domains, because each plugin is a further check the
 * account is billed for.
 */
export async function domainReputation(
    apiKey: string,
    domain: string,
    adult: boolean
): Promise<{ fraud: boolean; adult: boolean }> {
    const client = new DymoAPI({ apiKey });
    const answer = DOMAIN_REPUTATION.parse(
        await client.isValidDataRaw({ domain, ...(adult ? { plugins: ["nsfw"] } : {}) })
    );
    return {
        fraud: answer.domain?.fraud === true,
        adult: adult && answer.domain?.plugins?.nsfw === true
    };
}
