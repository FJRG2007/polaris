/**
 * Policies admin. Lists every policy with its document and attachments and lets
 * an admin author policies and bind them to users, groups, or roles. A policy is
 * a JSON document of allow/deny statements resolved by the @polaris/core engine;
 * the page resolves attachment ids to human labels so the bindings read clearly.
 *
 * Only the people a policy is attached to are read - by id - never the whole
 * directory: somebody to attach is found by name.
 */

import { prisma } from "@polaris/db";
import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { PoliciesAdmin, type PolicyRow, type PrincipalOption } from "./policies-admin";

export const dynamic = "force-dynamic";

export default async function PoliciesAdminPage() {
    await requireAdmin();
    const t = await getTranslations("admin");
    const [policies, groups, roles] = await Promise.all([
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
        prisma.group.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
        prisma.role.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } })
    ]);

    const attachedUserIds = [
        ...new Set(
            policies.flatMap((policy) =>
                policy.attachments
                    .filter((attachment) => attachment.principalType === "user")
                    .map((attachment) => attachment.principalId)
            )
        )
    ];
    const users = attachedUserIds.length
        ? await prisma.user.findMany({ where: { id: { in: attachedUserIds } }, select: { id: true, name: true } })
        : [];

    // A lookup so an attachment (type + id) can be shown as a readable label.
    const label = new Map<string, string>();
    for (const user of users) label.set(`user:${user.id}`, user.name);
    for (const group of groups) label.set(`group:${group.id}`, t("policies.principal.group", { name: group.name }));
    for (const role of roles) label.set(`role:${role.id}`, t("policies.principal.role", { name: role.name }));

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
        ...roles.map((role) => ({ type: "role" as const, id: role.id, label: t("policies.principal.role", { name: role.name }) })),
        ...groups.map((group) => ({ type: "group" as const, id: group.id, label: t("policies.principal.group", { name: group.name }) }))
    ];

    return (
        <>
            <PageHeader
                title={t("policies.page.title")}
                description={t("policies.page.description")}
            />
            <PoliciesAdmin policies={rows} principals={principals} />
        </>
    );
}
