"use server";

/**
 * The instance's security policy, as an administrator sets it.
 *
 * One action, because the policy is one decision with a qualifier and saving half
 * of it would leave a state nobody chose - a requirement on with nothing accepted
 * is an instance nobody can enter.
 */

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { instanceSecuritySchema } from "@polaris/core";
import { setInstanceSecurity } from "@/lib/instance-security";

export async function saveInstanceSecurityAction(input: unknown): Promise<{ error?: string; ok?: string }> {
    const admin = await requireAdmin();
    const parsed = instanceSecuritySchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };

    await setInstanceSecurity(parsed.data);
    await recordAudit({
        actorId: admin.id,
        action: "instance.security.updated",
        metadata: {
            requireSecondFactor: parsed.data.requireSecondFactor,
            acceptedFactors: parsed.data.acceptedFactors,
            challengeConnectionSignIn: parsed.data.challengeConnectionSignIn
        }
    });
    revalidatePath("/admin/security");
    return { ok: "Saved." };
}
