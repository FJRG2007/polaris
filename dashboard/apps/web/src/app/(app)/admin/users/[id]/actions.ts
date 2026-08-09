"use server";

/**
 * What an administrator changes about one person's access, from the page that
 * shows all of it at once.
 *
 * The decisions live in the services these call - this file only checks that the
 * caller is an administrator, validates the shape, and refreshes the page. A
 * server action is a public endpoint whatever rendered it.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { parseResource } from "@polaris/core";
import { recordAudit } from "@/lib/audit-service";
import { explainUserAccess, type AccessExplanation } from "@/lib/access-explain-service";
import { addGroupMember, attachPolicy, detachPolicy, removeGroupMember, removeResourceGrant } from "@polaris/auth";

const idSchema = z.string().uuid();

/** Everything this account can do, and why. Loaded after the page paints: it is
 *  a resolution per source per permission, and the shell has nothing to wait for. */
export async function userAccessAction(userId: string): Promise<{ access?: AccessExplanation; error?: string }> {
    await requireAdmin();
    const parsed = idSchema.safeParse(userId);
    if (!parsed.success) return { error: "Unknown account." };
    try {
        return { access: await explainUserAccess(parsed.data) };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not work out their access" };
    }
}

/** Put somebody in a group, or take them out of it. */
export async function setUserGroupAction(
    userId: string,
    groupId: string,
    member: boolean
): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = z.object({ userId: idSchema, groupId: idSchema }).safeParse({ userId, groupId });
    if (!parsed.success) return { error: "Unknown group." };
    if (member) await addGroupMember(parsed.data.groupId, parsed.data.userId);
    else await removeGroupMember(parsed.data.groupId, parsed.data.userId);
    await recordAudit({
        actorId: admin.id,
        action: member ? "group.member.add" : "group.member.remove",
        targetType: "group",
        targetId: parsed.data.groupId,
        metadata: { userId: parsed.data.userId }
    });
    revalidatePath(`/admin/users/${parsed.data.userId}`);
    revalidatePath("/admin/groups");
    return {};
}

/** Attach a policy directly to this account, or take it off. */
export async function setUserPolicyAction(
    userId: string,
    policyId: string,
    attached: boolean
): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = z.object({ userId: idSchema, policyId: idSchema }).safeParse({ userId, policyId });
    if (!parsed.success) return { error: "Unknown policy." };
    if (attached) await attachPolicy(parsed.data.policyId, "user", parsed.data.userId);
    else await detachPolicy(parsed.data.policyId, "user", parsed.data.userId);
    await recordAudit({
        actorId: admin.id,
        action: attached ? "policy.attach" : "policy.detach",
        targetType: "policy",
        targetId: parsed.data.policyId,
        metadata: { principalType: "user", principalId: parsed.data.userId }
    });
    revalidatePath(`/admin/users/${parsed.data.userId}`);
    revalidatePath("/admin/policies");
    return {};
}

/** Take away access this account was given to one particular thing. */
export async function removeUserGrantAction(
    userId: string,
    grantId: string,
    resource: string
): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = z.object({ userId: idSchema, grantId: idSchema }).safeParse({ userId, grantId });
    if (!parsed.success) return { error: "Unknown access." };
    const ref = parseResource(resource);
    if (!ref) return { error: "Unknown access." };
    await removeResourceGrant(ref, parsed.data.grantId);
    await recordAudit({
        actorId: admin.id,
        action: "app.access.revoke",
        targetType: ref.kind === "install" ? "installedApp" : ref.kind,
        targetId: ref.id,
        metadata: { to: parsed.data.userId, grantId: parsed.data.grantId }
    });
    revalidatePath(`/admin/users/${parsed.data.userId}`);
    return {};
}
