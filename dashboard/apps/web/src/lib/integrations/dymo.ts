/**
 * Thin wrapper over the official Dymo SDK for the one call Polaris makes: verify a
 * visitor IP against a set of deny rules. Kept isolated so the rest of the app
 * depends on a plain result shape, not the SDK.
 */

import DymoAPI, { type NegativeEmailRules, type NegativeIPRules } from "dymo-api";

/** Verify an IP; `allow` is false when it matches any of the `deny` conditions. */
export async function verifyIp(
    apiKey: string,
    ip: string,
    deny: string[]
): Promise<{ allow: boolean; reasons: string[] }> {
    const client = new DymoAPI({ apiKey });
    const result = await client.isValidIP(ip, { deny: deny as NegativeIPRules[] });
    return { allow: result.allow, reasons: result.reasons ?? [] };
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
    const result = await client.isValidEmail(email, { deny: [...deny] });
    return { allow: result.allow, reasons: result.reasons ?? [] };
}
