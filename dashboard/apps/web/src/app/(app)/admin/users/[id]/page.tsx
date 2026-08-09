/**
 * One person's access, all of it, in one place.
 *
 * Until now this was four screens: a role was defined under Roles, membership
 * under Groups, a document under Policies, and access to one server on that
 * server. Each could answer what it held; none could answer the question an
 * administrator actually arrives with, which is "what can this person do, and
 * what do I change to stop it".
 *
 * The shell and everything cheap render from props. The explanation - a
 * resolution per source per permission, plus the things they were given access to
 * - loads after the paint, because nothing above it is waiting on the answer.
 */

import { prisma } from "@polaris/db";
import { PageHeader } from "@polaris/ui";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/session";
import { UserAccessView } from "./access-view";
import { listRoleOptions } from "@/lib/role-service";

export const dynamic = "force-dynamic";

export default async function UserAccessPage({ params }: { params: Promise<{ id: string }> }) {
    await requireAdmin();
    const { id } = await params;
    const account = await prisma.user.findUnique({
        where: { id },
        select: {
            id: true,
            name: true,
            email: true,
            isAdmin: true,
            bannedAt: true,
            roles: { select: { role: { select: { name: true } } } },
            groups: { select: { groupId: true } }
        }
    });
    if (!account) notFound();

    const [roles, groups, policies, attachments] = await Promise.all([
        listRoleOptions(),
        prisma.group.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, description: true } }),
        prisma.policy.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, description: true } }),
        prisma.policyAttachment.findMany({
            where: { principalType: "user", principalId: id },
            select: { policyId: true }
        })
    ]);

    return (
        <>
            <PageHeader
                title={account.name}
                description={account.email}
            />
            <UserAccessView
                userId={account.id}
                isAdmin={account.isAdmin}
                banned={account.bannedAt !== null}
                role={account.roles[0]?.role.name ?? null}
                roles={roles.map((option) => option.name)}
                groups={groups}
                memberOf={account.groups.map((row) => row.groupId)}
                policies={policies}
                attachedPolicies={attachments.map((row) => row.policyId)}
            />
        </>
    );
}
