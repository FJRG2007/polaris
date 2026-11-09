"use server";

import { prisma } from "@polaris/db";
import { policyTemplateOf } from "@polaris/core";
import { syncPolicyTemplates } from "@polaris/auth";
import { publishAccessChange } from "@/lib/access-live";
import { requireAdmin } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import type { PolicyRow, PrincipalOption } from "./policies-admin";

/** Every policy with who it is attached to, and who it can be, after the paint. */
export async function loadPoliciesAdminAction(): Promise<{
    policies: PolicyRow[];
    principals: PrincipalOption[];
}> {
    await requireAdmin();
    // The ready-made ones are here before anybody can attach one. A write only
    // happens on the first visit after an update that changed a template.
    if (await syncPolicyTemplates()) publishAccessChange();
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
        ? await prisma.user.findMany({
              where: { id: { in: attachedUserIds } },
              select: { id: true, name: true }
          })
        : [];

    // A lookup so an attachment (type + id) can be shown as a readable label.
    const label = new Map<string, string>();
    for (const user of users) label.set(`user:${user.id}`, user.name);
    for (const group of groups)
        label.set(`group:${group.id}`, t("policies.principal.group", { name: group.name }));
    for (const role of roles)
        label.set(`role:${role.id}`, t("policies.principal.role", { name: role.name }));

    return {
        policies: policies.map((policy) => ({
            id: policy.id,
            name: policy.name,
            description: policy.description,
            isSystem: policy.isSystem,
            template: policy.isSystem ? (policyTemplateOf(policy.name)?.key ?? null) : null,
            document: policy.document,
            attachments: policy.attachments.map((attachment) => ({
                principalType: attachment.principalType as PrincipalOption["type"],
                principalId: attachment.principalId,
                label:
                    label.get(`${attachment.principalType}:${attachment.principalId}`) ??
                    attachment.principalId
            }))
        })),
        principals: [
            ...roles.map((role) => ({
                type: "role" as const,
                id: role.id,
                label: t("policies.principal.role", { name: role.name })
            })),
            ...groups.map((group) => ({
                type: "group" as const,
                id: group.id,
                label: t("policies.principal.group", { name: group.name })
            }))
        ]
    };
}
