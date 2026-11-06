/**
 * What this person can do, and why: groups, policies, capabilities and the
 * things they were given access to.
 *
 * The only section that needs the group and policy catalogues, so they are read
 * here and nowhere else. The resolution itself loads after the paint.
 */

import { prisma } from "@polaris/db";
import { requireAdmin } from "@/lib/session";
import { loadUserRecord } from "../user-record";
import { UserAccessView } from "../access-view";
import { listRoleOptions } from "@/lib/role-service";

export const dynamic = "force-dynamic";

export default async function UserAccessPage({ params }: { params: Promise<{ id: string }> }) {
    await requireAdmin();
    const { id } = await params;
    const [account, roles, groups, memberships, policies, attachments] = await Promise.all([
        loadUserRecord(id),
        listRoleOptions(),
        prisma.group.findMany({
            orderBy: { name: "asc" },
            select: { id: true, name: true, description: true }
        }),
        // The directory carries group NAMES, which is what a row shows. The editor
        // needs the ids it checks boxes against.
        prisma.groupMember.findMany({ where: { userId: id }, select: { groupId: true } }),
        prisma.policy.findMany({
            orderBy: { name: "asc" },
            select: { id: true, name: true, description: true }
        }),
        prisma.policyAttachment.findMany({
            where: { principalType: "user", principalId: id },
            select: { policyId: true }
        })
    ]);

    return (
        <UserAccessView
            userId={account.id}
            role={account.roles[0] ?? null}
            roles={roles.map((option) => option.name)}
            groups={groups}
            memberOf={memberships.map((row) => row.groupId)}
            policies={policies}
            attachedPolicies={attachments.map((row) => row.policyId)}
        />
    );
}
