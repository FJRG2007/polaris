"use server";

/**
 * The account's own access rules: save the list, and judge a draft of it against
 * the session making the request, so nobody locks themselves out without seeing
 * it coming.
 *
 * A save that would block the very session making it is refused with that reason
 * rather than applied. One that would only challenge it is allowed - the owner can
 * answer a challenge - and the preview says so first. After a save every other open
 * session is judged against the new rules at once, and the change is audited.
 */

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { getTranslations } from "@/lib/i18n/request";
import { newDeviceRefusal } from "@/lib/device-grace";
import { localized } from "../security/action-messages";
import { revokeSessionsRefusedByRules } from "@/lib/session-guard";
import { accountRulesSchema, evaluateAccountRules, type AccountRule } from "@polaris/core";
import { listAccountRules, resolveAccountRuleFacts, saveAccountRules } from "@/lib/account-rules";
import { clientIp, clientUserAgent, clientUserAgentBrands, clientUserAgentPlatform } from "@/lib/request-context";

export interface RulePreview {
    action: AccountRule["action"];
    ruleName: string | null;
    ip: string | null;
    country: string | null;
    browser: string | null;
    os: string | null;
}

type Result<T = object> = ({ error?: undefined } & T) | { error: string };

/** What the rules would do to the session asking. */
async function judgeCurrent(userId: string, rules: readonly AccountRule[]): Promise<RulePreview> {
    const [ip, userAgent, brands, platform] = await Promise.all([
        clientIp(),
        clientUserAgent(),
        clientUserAgentBrands(),
        clientUserAgentPlatform()
    ]);
    const facts = await resolveAccountRuleFacts(userId, rules, ip ?? null, {
        userAgent: userAgent ?? null,
        brands: brands ?? null,
        platform: platform ?? null
    });
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

export async function previewAccountRulesAction(input: unknown): Promise<Result<{ preview: RulePreview }>> {
    const user = await requireUser();
    const parsed = accountRulesSchema.safeParse(input);
    if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? (await getTranslations("account"))("access.errors.checkRules") };
    }
    return { preview: await judgeCurrent(user.id, parsed.data) };
}

export async function saveAccountRulesAction(input: unknown): Promise<Result> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return localized({ error: blocked });
    const parsed = accountRulesSchema.safeParse(input);
    if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? (await getTranslations("account"))("access.errors.checkRules") };
    }
    const preview = await judgeCurrent(user.id, parsed.data);
    if (preview.action === "block") {
        return { error: (await getTranslations("account"))("access.rules.lockout", { rule: preview.ruleName ?? "" }) };
    }

    const before = await listAccountRules(user.id);
    await saveAccountRules(user.id, parsed.data);
    await recordAudit({
        actorId: user.id,
        action: "account.access-rules.updated",
        metadata: {
            before: before.map((rule) => ({ name: rule.name, action: rule.action, enabled: rule.enabled })),
            after: parsed.data.map((rule) => ({ name: rule.name, action: rule.action, enabled: rule.enabled }))
        }
    });
    await revokeSessionsRefusedByRules(user.id);
    revalidatePath("/account/access");
    return {};
}
