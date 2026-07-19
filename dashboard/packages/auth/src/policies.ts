/**
 * Policies: reusable allow/deny documents bound to principals (users, groups, or
 * roles). A policy's document is a set of statements evaluated by the pure engine
 * in @polaris/core; this module owns persistence and the resolution of which
 * statements apply to a given user. Documents are validated on write AND on read,
 * so a hand-edited or corrupt row can never widen access - it simply contributes
 * no statements.
 */

import { policyDocumentSchema, type PolicyStatement } from "@polaris/core";
import { prisma } from "@polaris/db";
import { getUserGroupIds } from "./groups.js";

/** The kinds of principal a policy can attach to. */
export type PrincipalType = "user" | "group" | "role";

/** A policy row summarised for admin listings. */
export interface PolicySummary {
    id: string;
    name: string;
    description: string | null;
    isSystem: boolean;
    attachmentCount: number;
}

/** Validate and store a policy document, returning the parsed statements. */
function serializeDocument(document: unknown): string {
    const parsed = policyDocumentSchema.safeParse(document);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid policy document");
    return JSON.stringify(parsed.data);
}

/** Parse a stored document into statements; any malformed row yields none. */
function parseDocument(raw: string): PolicyStatement[] {
    try {
        const parsed = policyDocumentSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data.statements : [];
    } catch {
        return [];
    }
}

/** Create a policy. Throws on a duplicate name or an invalid document. */
export async function createPolicy(
    name: string,
    description: string | undefined,
    document: unknown
): Promise<{ id: string }> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Enter a policy name");
    return prisma.policy.create({
        data: { name: trimmed, description: description?.trim() || null, document: serializeDocument(document) },
        select: { id: true }
    });
}

/** Update a policy's name, description, and/or document. System policies are read-only. */
export async function updatePolicy(
    id: string,
    changes: { name?: string; description?: string | null; document?: unknown }
): Promise<void> {
    const existing = await prisma.policy.findUnique({ where: { id }, select: { isSystem: true } });
    if (!existing || existing.isSystem) throw new Error("Policy not found");
    await prisma.policy.update({
        where: { id },
        data: {
            ...(changes.name !== undefined ? { name: changes.name.trim() } : {}),
            ...(changes.description !== undefined ? { description: changes.description?.trim() || null } : {}),
            ...(changes.document !== undefined ? { document: serializeDocument(changes.document) } : {})
        }
    });
}

/** Delete a policy (its attachments cascade). System policies are protected. */
export async function deletePolicy(id: string): Promise<void> {
    await prisma.policy.deleteMany({ where: { id, isSystem: false } });
}

/** All policies with attachment counts, alphabetical. */
export async function listPolicies(): Promise<PolicySummary[]> {
    const rows = await prisma.policy.findMany({
        orderBy: { name: "asc" },
        select: {
            id: true,
            name: true,
            description: true,
            isSystem: true,
            _count: { select: { attachments: true } }
        }
    });
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        isSystem: row.isSystem,
        attachmentCount: row._count.attachments
    }));
}

/** A policy with its raw document and attachments, or null. */
export async function getPolicy(id: string) {
    return prisma.policy.findUnique({
        where: { id },
        select: {
            id: true,
            name: true,
            description: true,
            isSystem: true,
            document: true,
            attachments: { select: { id: true, principalType: true, principalId: true } }
        }
    });
}

/** Bind a policy to a principal. No-op if the binding already exists. */
export async function attachPolicy(
    policyId: string,
    principalType: PrincipalType,
    principalId: string
): Promise<void> {
    await prisma.policyAttachment.upsert({
        where: { policyId_principalType_principalId: { policyId, principalType, principalId } },
        create: { policyId, principalType, principalId },
        update: {}
    });
}

/** Remove a policy binding. Idempotent. */
export async function detachPolicy(
    policyId: string,
    principalType: PrincipalType,
    principalId: string
): Promise<void> {
    await prisma.policyAttachment.deleteMany({ where: { policyId, principalType, principalId } });
}

/**
 * Every policy statement that applies to a user, gathered across the principals
 * they resolve to: themselves, each group they belong to, and each role they
 * hold. This is the set fed to the engine for both global-capability and
 * Drive-resource decisions (the caller supplies the action and resource).
 */
export async function resolvePrincipalPolicyStatements(userId: string): Promise<PolicyStatement[]> {
    const [groupIds, roleRows] = await Promise.all([
        getUserGroupIds(userId),
        prisma.userRole.findMany({ where: { userId }, select: { roleId: true } })
    ]);
    const principals: { principalType: PrincipalType; principalId: string }[] = [
        { principalType: "user", principalId: userId },
        ...groupIds.map((id) => ({ principalType: "group" as const, principalId: id })),
        ...roleRows.map((row) => ({ principalType: "role" as const, principalId: row.roleId }))
    ];

    const attachments = await prisma.policyAttachment.findMany({
        where: { OR: principals },
        select: { policyId: true }
    });
    const policyIds = [...new Set(attachments.map((row) => row.policyId))];
    if (policyIds.length === 0) return [];

    const policies = await prisma.policy.findMany({
        where: { id: { in: policyIds } },
        select: { document: true }
    });
    return policies.flatMap((policy) => parseDocument(policy.document));
}
