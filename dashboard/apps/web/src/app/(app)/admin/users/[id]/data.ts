"use server";

/**
 * One person's record and what each of its sections needs, asked for by the
 * browser after the record's shell has painted (`loaders.tsx`). Each read
 * checks the administrator again: a server action is an endpoint of its own.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { requireAdmin } from "@/lib/session";
import { listRoleOptions } from "@/lib/role-service";
import { getDirectoryUser, listImposableGroups } from "@/lib/user-admin-service";

const userId = z.string().trim().min(1).max(200);

export async function loadUserRecordAction(id: string) {
    await requireAdmin();
    return getDirectoryUser(userId.parse(id));
}

export async function loadUserOverviewAction(id: string) {
    const admin = await requireAdmin();
    const [account, roles] = await Promise.all([getDirectoryUser(userId.parse(id)), listRoleOptions()]);
    return account ? { account, roles, isSelf: account.id === admin.id } : null;
}

export async function loadUserAccessAction(id: string) {
    await requireAdmin();
    const parsed = userId.parse(id);
    const [account, roles, groups, memberships, policies, attachments] = await Promise.all([
        getDirectoryUser(parsed),
        listRoleOptions(),
        prisma.group.findMany({
            orderBy: { name: "asc" },
            select: { id: true, name: true, description: true }
        }),
        // The directory carries group NAMES, which is what a row shows. The editor
        // needs the ids it checks boxes against.
        prisma.groupMember.findMany({ where: { userId: parsed }, select: { groupId: true } }),
        prisma.policy.findMany({
            orderBy: { name: "asc" },
            select: { id: true, name: true, description: true }
        }),
        prisma.policyAttachment.findMany({
            where: { principalType: "user", principalId: parsed },
            select: { policyId: true }
        })
    ]);
    if (!account) return null;
    return {
        userId: account.id,
        role: account.roles[0] ?? null,
        roles: roles.map((option) => option.name),
        groups,
        memberOf: memberships.map((row) => row.groupId),
        policies,
        attachedPolicies: attachments.map((row) => row.policyId)
    };
}

export async function loadUserSecurityAction(id: string) {
    const admin = await requireAdmin();
    const [account, groups] = await Promise.all([
        getDirectoryUser(userId.parse(id)),
        listImposableGroups(admin.id)
    ]);
    if (!account) return null;
    return {
        account,
        isSelf: account.id === admin.id,
        groups: groups.map((group) => ({ id: group.id, name: group.name }))
    };
}

export async function loadUserDangerAction(id: string) {
    const admin = await requireAdmin();
    const account = await getDirectoryUser(userId.parse(id));
    return account ? { account, isSelf: account.id === admin.id } : null;
}
