/**
 * Thin wrapper over the official Dymo SDK for the one call Polaris makes: verify a
 * visitor IP against a set of deny rules. Kept isolated so the rest of the app
 * depends on a plain result shape, not the SDK.
 */

import DymoAPI, { type NegativeIPRules } from "dymo-api";

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
