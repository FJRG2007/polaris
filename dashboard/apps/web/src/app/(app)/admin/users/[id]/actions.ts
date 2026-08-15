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
import { prisma } from "@polaris/db";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { PERMISSIONS, PERMISSION_META, isAllowed, parseResource, type Permission } from "@polaris/core";
import { explainUserAccess, type AccessExplanation } from "@/lib/access-explain-service";
import {
    addGroupMember,
    attachPolicy,
    detachPolicy,
    removeGroupMember,
    removeResourceGrant,
    resolveGlobalStatementsBySource
} from "@polaris/auth";

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

/** One capability, as the switches on the profile need it. */
export interface CapabilityState {
    readonly permission: Permission;
    readonly area: string;
    readonly label: string;
    /** What their role and policies say on their own, with any override taken
     *  back out - which is what "follow their role" would leave them with. */
    readonly inherited: boolean;
    /** The override set on this account, or null when there is none. */
    readonly override: "allow" | "deny" | null;
}

/**
 * Every capability, what this account's role says about it, and what has been
 * set on the account itself.
 *
 * Loaded after the page paints, like the rest of the access panel: it is a
 * resolution per permission and the shell has nothing to wait for.
 */
export async function userCapabilitiesAction(
    userId: string
): Promise<{ capabilities?: CapabilityState[]; isAdmin?: boolean; error?: string }> {
    await requireAdmin();
    const parsed = idSchema.safeParse(userId);
    if (!parsed.success) return { error: "Unknown account." };

    const [account, sourced, overrides] = await Promise.all([
        prisma.user.findUnique({ where: { id: parsed.data }, select: { isAdmin: true } }),
        resolveGlobalStatementsBySource(parsed.data),
        prisma.userPermission.findMany({
            where: { userId: parsed.data },
            select: { permission: true, effect: true }
        })
    ]);
    if (!account) return { error: "Unknown account." };

    // Everything except the overrides, which is exactly what switching one back
    // to "follow their role" would leave in force.
    const inheritedStatements = sourced
        .filter((entry) => entry.source.kind !== "account")
        .flatMap((entry) => entry.statements);
    const set = new Map(overrides.map((row) => [row.permission, row.effect]));

    return {
        isAdmin: account.isAdmin,
        capabilities: PERMISSIONS.map((permission) => ({
            permission,
            area: PERMISSION_META[permission].area,
            label: PERMISSION_META[permission].label,
            inherited: isAllowed(inheritedStatements, permission, "*"),
            override: set.get(permission) === "deny" ? "deny" : set.has(permission) ? "allow" : null
        }))
    };
}

/**
 * Switch one capability on or off for one account, or hand it back to their role.
 *
 * Three states rather than a checkbox, because "not overridden" is a real answer
 * and is not the same as off: an account with no row follows whatever their role
 * and policies say, and flattening that into a boolean would turn every screen
 * paint into a decision somebody did not make.
 */
export async function setUserPermissionAction(
    userId: string,
    permission: string,
    state: "inherit" | "allow" | "deny"
): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = z
        .object({
            userId: idSchema,
            permission: z.enum(PERMISSIONS),
            state: z.enum(["inherit", "allow", "deny"])
        })
        .safeParse({ userId, permission, state });
    if (!parsed.success) return { error: "That is not a capability." };

    if (parsed.data.state === "inherit") {
        await prisma.userPermission.deleteMany({
            where: { userId: parsed.data.userId, permission: parsed.data.permission }
        });
    } else {
        await prisma.userPermission.upsert({
            where: {
                userId_permission: {
                    userId: parsed.data.userId,
                    permission: parsed.data.permission
                }
            },
            update: { effect: parsed.data.state, setById: admin.id },
            create: {
                userId: parsed.data.userId,
                permission: parsed.data.permission,
                effect: parsed.data.state,
                setById: admin.id
            }
        });
    }

    await recordAudit({
        actorId: admin.id,
        action: "user.permission.set",
        targetType: "user",
        targetId: parsed.data.userId,
        metadata: { permission: parsed.data.permission, state: parsed.data.state }
    });
    revalidatePath(`/admin/users/${parsed.data.userId}`);
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
