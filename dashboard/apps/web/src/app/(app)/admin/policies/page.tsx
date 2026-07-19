/**
 * Policies admin. Lists every policy with its document and attachments and lets
 * an admin author policies and bind them to users, groups, or roles. A policy is
 * a JSON document of allow/deny statements resolved by the @polaris/core engine;
 * the page resolves attachment ids to human labels so the bindings read clearly.
 */

import { prisma } from "@polaris/db";
import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { PoliciesAdmin, type PolicyRow, type PrincipalOption } from "./policies-admin";

export const dynamic = "force-dynamic";

export default async function PoliciesAdminPage() {
    await requireAdmin();
    const [policies, users, groups, roles] = await Promise.all([
        prisma.policy.findMany({
            orderBy: { name: "asc" },
            select: {
                id: true,
                name: true,
                description: true,
                isSystem: true,
                document: true,
                attachments: { select: { principalType: true, principalId: true } }
            }
        }),
        prisma.user.findMany({ select: { id: true, name: true, email: true }, orderBy: { name: "asc" } }),
        prisma.group.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
        prisma.role.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } })
    ]);

    // A lookup so an attachment (type + id) can be shown as a readable label.
    const label = new Map<string, string>();
    for (const user of users) label.set(`user:${user.id}`, user.name);
    for (const group of groups) label.set(`group:${group.id}`, `${group.name} (group)`);
    for (const role of roles) label.set(`role:${role.id}`, `${role.name} (role)`);

    const rows: PolicyRow[] = policies.map((policy) => ({
        id: policy.id,
        name: policy.name,
        description: policy.description,
        isSystem: policy.isSystem,
        document: policy.document,
        attachments: policy.attachments.map((attachment) => ({
            principalType: attachment.principalType as PrincipalOption["type"],
            principalId: attachment.principalId,
            label: label.get(`${attachment.principalType}:${attachment.principalId}`) ?? attachment.principalId
        }))
    }));

    const principals: PrincipalOption[] = [
        ...roles.map((role) => ({ type: "role" as const, id: role.id, label: `${role.name} (role)` })),
        ...groups.map((group) => ({ type: "group" as const, id: group.id, label: `${group.name} (group)` })),
        ...users.map((user) => ({ type: "user" as const, id: user.id, label: `${user.name} (${user.email})` }))
    ];

    return (
        <>
            <PageHeader
                title="Policies"
                description="Fine-grained allow/deny rules. Attach a policy to a user, group, or role."
            />
            <PoliciesAdmin policies={rows} principals={principals} />
        </>
    );
}
