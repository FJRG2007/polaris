/**
 * What the account's rules would do to the session making this request - the
 * check every change on the access screen runs before it is written, so nobody
 * locks themselves out without seeing it coming.
 *
 * A plain server module rather than part of the actions file: everything a
 * "use server" file exports is callable from a browser, and this takes a user id.
 */

import { evaluateAccountRules, type AccountRule } from "@polaris/core";
import { resolveAccountRuleFacts, type GroupChange } from "@/lib/account-rules";
import { clientIp, clientUserAgent, clientUserAgentBrands, clientUserAgentPlatform } from "@/lib/request-context";

export interface RulePreview {
    action: AccountRule["action"];
    ruleName: string | null;
    ip: string | null;
    country: string | null;
    browser: string | null;
    os: string | null;
}

export async function judgeCurrentSession(
    userId: string,
    rules: readonly AccountRule[],
    groupChange?: GroupChange
): Promise<RulePreview> {
    const [ip, userAgent, brands, platform] = await Promise.all([
        clientIp(),
        clientUserAgent(),
        clientUserAgentBrands(),
        clientUserAgentPlatform()
    ]);
    const facts = await resolveAccountRuleFacts(
        userId,
        rules,
        ip ?? null,
        { userAgent: userAgent ?? null, brands: brands ?? null, platform: platform ?? null },
        undefined,
        groupChange
    );
    const verdict = evaluateAccountRules(rules, facts);
    return {
        action: verdict.action,
        ruleName: verdict.rule?.name ?? null,
        ip: facts.ip,
        country: facts.country,
        browser: facts.browser,
        os: facts.os
    };
}
