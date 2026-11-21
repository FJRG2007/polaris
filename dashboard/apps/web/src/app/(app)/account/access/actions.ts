"use server";

/**
 * Saved address lists: the reusable groups of addresses and locations the
 * account's access rules and its API keys are built from.
 *
 * Editing or deleting a list the access rules name changes what those rules do,
 * so every such change is judged against the session making it before it is
 * written: one that would block that session is refused with the rule's name
 * instead of being applied. The account's rules themselves are saved through
 * `rule-actions.ts`.
 */

import { revalidatePath } from "next/cache";
import { createAccessGroup, deleteAccessGroup, updateAccessGroup } from "@polaris/auth";
import { accessGroupSchema, stringifyList, unionRules } from "@polaris/core";
import { recordAudit } from "@/lib/audit-service";
import { requireUser } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { localized } from "../security/action-messages";
import { newDeviceRefusal } from "@/lib/device-grace";
import { judgeCurrentSession } from "./current-session";
import { listAccountRules, type GroupChange } from "@/lib/account-rules";
import { revokeSessionsRefusedByRules } from "@/lib/session-guard";

type ActionResult = { error?: string };

/** Refuse a change to a list that would make the account's rules block this
 *  very session, naming the rule that would. */
async function lockoutFor(userId: string, change: GroupChange): Promise<ActionResult | null> {
    const rules = await listAccountRules(userId);
    if (rules.length === 0) return null;
    const preview = await judgeCurrentSession(userId, rules, change);
    if (preview.action !== "block") return null;
    return { error: (await getTranslations("account"))("access.rules.lockout", { rule: preview.ruleName ?? "" }) };
}

/** A schema's first complaint, or the screen's own sentence. */
async function checkTheGroup(issue: string | undefined): Promise<ActionResult> {
    return { error: issue ?? (await getTranslations("account"))("access.errors.checkGroup") };
}

export async function createAccessGroupAction(input: unknown): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return localized({ error: blocked });
    const parsed = accessGroupSchema.safeParse(input);
    if (!parsed.success) return checkTheGroup(parsed.error.issues[0]?.message);
    // A new list is named by no rule yet, so it cannot lock anyone out.
    const result = await createAccessGroup(user.id, parsed.data);
    if (result.error) return { error: result.error };
    await recordAudit({ actorId: user.id, action: "account.access-group.created", targetId: result.id });
    revalidatePath("/account/access");
    return {};
}

export async function updateAccessGroupAction(id: string, input: unknown): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return localized({ error: blocked });
    const parsed = accessGroupSchema.safeParse(input);
    if (!parsed.success) return checkTheGroup(parsed.error.issues[0]?.message);

    const replacement = unionRules([
        {
            allowedCidrs: stringifyList(parsed.data.allowedCidrs),
            allowedCountries: stringifyList(parsed.data.allowedCountries),
            allowedContinents: stringifyList(parsed.data.allowedContinents)
        }
    ]);
    const refused = await lockoutFor(user.id, { id: String(id), replacement });
    if (refused) return refused;

    const result = await updateAccessGroup(user.id, String(id), parsed.data);
    if (result.error) return result;
    await recordAudit({ actorId: user.id, action: "account.access-group.updated", targetId: String(id) });
    // A list a rule names now admits something else: judge the other sessions by it.
    await revokeSessionsRefusedByRules(user.id);
    revalidatePath("/account/access");
    return {};
}

export async function deleteAccessGroupAction(id: string): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return localized({ error: blocked });
    const refused = await lockoutFor(user.id, { id: String(id), replacement: null });
    if (refused) return refused;

    await deleteAccessGroup(user.id, String(id));
    await recordAudit({ actorId: user.id, action: "account.access-group.deleted", targetId: String(id) });
    await revokeSessionsRefusedByRules(user.id);
    revalidatePath("/account/access");
    revalidatePath("/account/api-keys");
    return {};
}
