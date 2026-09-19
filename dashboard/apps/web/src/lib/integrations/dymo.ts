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
    domain: z
        .object({ valid: z.boolean().optional(), fraud: z.boolean().optional() })
        .optional()
});

/** Verify an IP; `allow` is false when it matches any of the `deny` conditions. */
export async function verifyIp(
    apiKey: string,
    ip: string,
    deny: string[]
): Promise<{ allow: boolean; reasons: string[] }> {
    const client = new DymoAPI({ apiKey });
    const answer = VERDICT.parse(await client.isValidIP(ip, { deny: deny as NegativeIPRules[] }));
    return { allow: answer.allow, reasons: answer.reasons ?? [] };
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
