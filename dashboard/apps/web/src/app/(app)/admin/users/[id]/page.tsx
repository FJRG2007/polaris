/**
 * One person, all of it, in one place.
 *
 * Until now this was five screens and a dialog: a role was defined under Roles,
 * membership under Groups, a document under Policies, access to one server on
 * that server, and who they are, where they may sign in from and how to stop
 * them lived in a panel over the people list. Each could answer what it held;
 * none could answer the question an administrator actually arrives with, which
 * is "what can this person do, and what do I change to stop it".
 *
 * The record is the top of the page and the resolution is under it, because
 * changing a role and reading what that role now reaches are the same visit.
 *
 * The shell and everything cheap render from props. The explanation - a
 * resolution per source per permission, plus the things they were given access
 * to - loads after the paint, because nothing above it is waiting on the answer.
 */

import Link from "next/link";
import { prisma } from "@polaris/db";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/session";
import { AccountView } from "./account-view";
import { IdentityCard } from "./identity-card";
import { UserAccessView } from "./access-view";
import { Badge, PageHeader } from "@polaris/ui";
import { listRoleOptions } from "@/lib/role-service";
import { getDirectoryUser, listImposableGroups } from "@/lib/user-admin-service";

export const dynamic = "force-dynamic";

export default async function UserAccessPage({ params }: { params: Promise<{ id: string }> }) {
    const admin = await requireAdmin();
    const { id } = await params;
    const account = await getDirectoryUser(id);
    if (!account) notFound();

    const [roles, accessGroups, groups, memberships, policies, attachments] = await Promise.all([
        listRoleOptions(),
        listImposableGroups(admin.id),
        prisma.group.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, description: true } }),
        // The directory carries group NAMES, which is what a row shows. The editor
        // below needs the ids it checks boxes against.
        prisma.groupMember.findMany({ where: { userId: id }, select: { groupId: true } }),
        prisma.policy.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, description: true } }),
        prisma.policyAttachment.findMany({
            where: { principalType: "user", principalId: id },
            select: { policyId: true }
        })
    ]);

    return (
        <>
            {/* Above the name, because that is where somebody looks for the way
                back out of a record they opened from a list. */}
            <Link
                href="/admin/users"
                className="mb-2 flex w-fit items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
                <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
                People
            </Link>
            <PageHeader
                title={account.name}
                description={account.email}
                actions={
                    <>
                        {account.isAdmin ? <Badge variant="primary">admin</Badge> : null}
                        {account.banned ? <Badge variant="danger">banned</Badge> : null}
                    </>
                }
            />
            {/* Who they are, before anything about what they may do. */}
            <div className="mb-4">
                <IdentityCard userId={account.id} />
            </div>
            <AccountView
                user={account}
                roles={roles}
                groups={accessGroups.map((group) => ({ id: group.id, name: group.name }))}
                isSelf={account.id === admin.id}
            />
            <div className="mt-4">
                <UserAccessView
                    userId={account.id}
                    role={account.roles[0] ?? null}
                    roles={roles.map((option) => option.name)}
                    groups={groups}
                    memberOf={memberships.map((row) => row.groupId)}
                    policies={policies}
                    attachedPolicies={attachments.map((row) => row.policyId)}
                />
            </div>
        </>
    );
}
