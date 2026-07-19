"use server";

/**
 * Admin-only policy management: create/update/delete policies and attach or
 * detach them to users, groups, or roles. Documents are parsed from the JSON the
 * admin types and validated by the service (which rejects a malformed shape), so
 * an invalid policy is never stored.
 */

import { revalidatePath } from "next/cache";
import {
    attachPolicy,
    createPolicy,
    deletePolicy,
    detachPolicy,
    updatePolicy,
    type PrincipalType
} from "@polaris/auth";
import { requireAdmin } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";

/** Parse the document text an admin typed into a value, or return an error. */
function parseDocument(documentText: string): { value?: unknown; error?: string } {
    try {
        return { value: JSON.parse(documentText) };
    } catch {
        return { error: "The policy document is not valid JSON" };
    }
}

export async function createPolicyAction(
    name: string,
    description: string,
    documentText: string
): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = parseDocument(documentText);
    if (parsed.error) return { error: parsed.error };
    try {
        const { id } = await createPolicy(name, description || undefined, parsed.value);
        await recordAudit({ actorId: admin.id, action: "policy.create", targetType: "policy", targetId: id, metadata: { name } });
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not create the policy" };
    }
    revalidatePath("/admin/policies");
    return {};
}

export async function updatePolicyAction(
    id: string,
    name: string,
    description: string,
    documentText: string
): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = parseDocument(documentText);
    if (parsed.error) return { error: parsed.error };
    try {
        await updatePolicy(id, { name, description, document: parsed.value });
        await recordAudit({ actorId: admin.id, action: "policy.update", targetType: "policy", targetId: id });
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not update the policy" };
    }
    revalidatePath("/admin/policies");
    return {};
}

export async function deletePolicyAction(id: string): Promise<void> {
    const admin = await requireAdmin();
    await deletePolicy(id);
    await recordAudit({ actorId: admin.id, action: "policy.delete", targetType: "policy", targetId: id });
    revalidatePath("/admin/policies");
}

export async function attachPolicyAction(
    policyId: string,
    principalType: PrincipalType,
    principalId: string
): Promise<void> {
    const admin = await requireAdmin();
    if (!principalId) return;
    await attachPolicy(policyId, principalType, principalId);
    await recordAudit({ actorId: admin.id, action: "policy.attach", targetType: "policy", targetId: policyId, metadata: { principalType, principalId } });
    revalidatePath("/admin/policies");
}

export async function detachPolicyAction(
    policyId: string,
    principalType: PrincipalType,
    principalId: string
): Promise<void> {
    const admin = await requireAdmin();
    await detachPolicy(policyId, principalType, principalId);
    await recordAudit({ actorId: admin.id, action: "policy.detach", targetType: "policy", targetId: policyId, metadata: { principalType, principalId } });
    revalidatePath("/admin/policies");
}
