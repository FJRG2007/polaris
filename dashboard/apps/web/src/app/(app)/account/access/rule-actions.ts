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
import { accountRulesSchema } from "@polaris/core";
import { getTranslations } from "@/lib/i18n/request";
import { newDeviceRefusal } from "@/lib/device-grace";
import { localized } from "../security/action-messages";
import { revokeSessionsRefusedByRules } from "@/lib/session-guard";
import { listAccountRules, saveAccountRules } from "@/lib/account-rules";
import { judgeCurrentSession, type RulePreview } from "./current-session";

export type { RulePreview } from "./current-session";

type Result<T = object> = ({ error?: undefined } & T) | { error: string; lockout?: RulePreview };

export async function previewAccountRulesAction(input: unknown): Promise<Result<{ preview: RulePreview }>> {
    const user = await requireUser();
    const parsed = accountRulesSchema.safeParse(input);
    if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? (await getTranslations("account"))("access.errors.checkRules") };
    }
    return { preview: await judgeCurrentSession(user.id, parsed.data) };
}

export async function saveAccountRulesAction(input: unknown): Promise<Result> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return localized({ error: blocked });
    const parsed = accountRulesSchema.safeParse(input);
    if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? (await getTranslations("account"))("access.errors.checkRules") };
    }
    const preview = await judgeCurrentSession(user.id, parsed.data);
    if (preview.action === "block") {
        return {
            error: (await getTranslations("account"))("access.rules.lockout", { rule: preview.ruleName ?? "" }),
            lockout: preview
        };
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
