"use server";

/**
 * Access-rule actions: the account's own sign-in restrictions and the reusable
 * groups behind them.
 *
 * Every mutation is checked against the caller's current address before it is
 * written. A network allowlist is the one setting a user can use to lock
 * themselves out of their own instance - and because the rules are a union, that
 * can happen by editing a group as easily as by editing the account - so a change
 * that would refuse the request making it is rejected with an explanation instead
 * of being applied.
 */

import { revalidatePath } from "next/cache";
import {
    createAccessGroup,
    deleteAccessGroup,
    updateAccessGroup,
    updateSignInRules
} from "@polaris/auth";
import {
    accessGroupSchema,
    accessRulesSchema,
    stringifyList,
    unionRules,
    type EffectiveAccessRules
} from "@polaris/core";
import { prisma } from "@polaris/db";
import { recordAudit } from "@/lib/audit-service";
import { evaluateNetworkRules } from "@/lib/network-rules";
import { clientIp } from "@/lib/request-context";
import { requireUser } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { localized } from "../security/action-messages";
import { newDeviceRefusal } from "@/lib/device-grace";

type ActionResult = { error?: string };

/** The stored column shape a rule set takes, so projections and rows mix freely. */
function toColumns(rules: {
    allowedCidrs: string[];
    allowedCountries: string[];
    allowedContinents: string[];
}) {
    return {
        allowedCidrs: stringifyList(rules.allowedCidrs),
        allowedCountries: stringifyList(rules.allowedCountries),
        allowedContinents: stringifyList(rules.allowedContinents)
    };
}

/** Refuse a change that would shut the caller's own address out. */
async function wouldLockOut(projected: EffectiveAccessRules): Promise<boolean> {
    const decision = await evaluateNetworkRules(projected, await clientIp());
    return !decision.allowed;
}

/** The refusal for a change that would shut this very browser out. */
async function lockout(): Promise<ActionResult> {
    return { error: (await getTranslations("account"))("access.errors.lockout") };
}

/** A schema's first complaint, or the given sentence of this screen's own. */
async function checkThe(issue: string | undefined, key: "access.errors.checkRules" | "access.errors.checkGroup"): Promise<ActionResult> {
    return { error: issue ?? (await getTranslations("account"))(key) };
}

export async function saveSignInRulesAction(input: unknown): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return localized({ error: blocked });
    const parsed = accessRulesSchema.safeParse(input);
    if (!parsed.success) return checkThe(parsed.error.issues[0]?.message, "access.errors.checkRules");

    const groups = await prisma.accessGroup.findMany({
        where: { ownerId: user.id, id: { in: parsed.data.groupIds } },
        select: { allowedCidrs: true, allowedCountries: true, allowedContinents: true }
    });
    if (await wouldLockOut(unionRules([toColumns(parsed.data), ...groups]))) {
        return lockout();
    }

    await updateSignInRules(user.id, parsed.data);
    await recordAudit({ actorId: user.id, action: "account.signin-rules.updated" });
    revalidatePath("/account/access");
    return {};
}

/** The union the account would sign in under, with one group swapped or dropped. */
async function projectWithGroupChange(
    userId: string,
    groupId: string,
    replacement: ReturnType<typeof toColumns> | null
): Promise<EffectiveAccessRules> {
    const [inline, bindings] = await Promise.all([
        prisma.userSecurity.findUnique({
            where: { userId },
            select: { allowedCidrs: true, allowedCountries: true, allowedContinents: true }
        }),
        prisma.userAccessGroup.findMany({
            where: { userId },
            select: {
                groupId: true,
                group: { select: { allowedCidrs: true, allowedCountries: true, allowedContinents: true } }
            }
        })
    ]);
    const sources = bindings.flatMap((binding) =>
        binding.groupId === groupId ? (replacement ? [replacement] : []) : [binding.group]
    );
    return unionRules([inline, ...sources]);
}

export async function createAccessGroupAction(input: unknown): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return localized({ error: blocked });
    const parsed = accessGroupSchema.safeParse(input);
    if (!parsed.success) return checkThe(parsed.error.issues[0]?.message, "access.errors.checkGroup");
    // A new group is not attached to anything yet, so it cannot lock anyone out.
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
    if (!parsed.success) return checkThe(parsed.error.issues[0]?.message, "access.errors.checkGroup");

    const projected = await projectWithGroupChange(user.id, String(id), toColumns(parsed.data));
    if (await wouldLockOut(projected)) return lockout();

    const result = await updateAccessGroup(user.id, String(id), parsed.data);
    if (result.error) return result;
    await recordAudit({ actorId: user.id, action: "account.access-group.updated", targetId: String(id) });
    revalidatePath("/account/access");
    return {};
}

export async function deleteAccessGroupAction(id: string): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return localized({ error: blocked });
    const projected = await projectWithGroupChange(user.id, String(id), null);
    if (await wouldLockOut(projected)) return lockout();

    await deleteAccessGroup(user.id, String(id));
    await recordAudit({ actorId: user.id, action: "account.access-group.deleted", targetId: String(id) });
    revalidatePath("/account/access");
    revalidatePath("/account/api-keys");
    return {};
}
