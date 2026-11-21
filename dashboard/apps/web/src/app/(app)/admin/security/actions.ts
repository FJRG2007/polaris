"use server";

/**
 * The instance's security policy, as an administrator sets it.
 *
 * One action, because the policy is one decision with a qualifier and saving half
 * of it would leave a state nobody chose - a requirement on with nothing accepted
 * is an instance nobody can enter.
 */

import { revalidatePath } from "next/cache";
import { prisma } from "@polaris/db";
import { requireAdmin } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { recordAudit } from "@/lib/audit-service";
import { instanceSecuritySchema } from "@polaris/core";
import { setInstanceSecurity } from "@/lib/instance-security";
import { setPlayerAddressesShared } from "@/lib/player-address-policy";

export async function saveInstanceSecurityAction(
    input: unknown
): Promise<{ error?: string; ok?: string }> {
    const admin = await requireAdmin();
    const parsed = instanceSecuritySchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? (await getTranslations("admin"))("security.errors.checkForm") };

    // Requiring keys from an administrator who holds none would hold their own
    // next request on a step they may not be able to finish, and on an address
    // where passkeys do not work it would hold everybody's. Holding one proves
    // both that they can sign in and that keys work here.
    if (parsed.data.requirePhishingResistant !== "off") {
        const own = await prisma.passkey.count({ where: { userId: admin.id } });
        if (own === 0) return { error: (await getTranslations("admin"))("security.phishing.needOwnKey") };
    }

    await setInstanceSecurity(parsed.data);
    await recordAudit({
        actorId: admin.id,
        action: "instance.security.updated",
        metadata: {
            requireSecondFactor: parsed.data.requireSecondFactor,
            acceptedFactors: parsed.data.acceptedFactors,
            challengeConnectionSignIn: parsed.data.challengeConnectionSignIn,
            requireLoginApproval: parsed.data.requireLoginApproval,
            requirePhishingResistant: parsed.data.requirePhishingResistant
        }
    });
    revalidatePath("/admin/security");
    return { ok: (await getTranslations("admin"))("security.saved") };
}

/** Whether the people running a game server are shown where other accounts sign in from. */
export async function savePlayerAddressesSharedAction(input: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    if (typeof input !== "boolean") return { error: (await getTranslations("admin"))("security.errors.onOrOff") };
    await setPlayerAddressesShared(input);
    await recordAudit({
        actorId: admin.id,
        action: "instance.games.player-addresses.updated",
        metadata: { shared: input }
    });
    revalidatePath("/admin/security");
    return {};
}
