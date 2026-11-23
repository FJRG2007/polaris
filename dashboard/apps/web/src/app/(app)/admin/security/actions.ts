"use server";

/**
 * The instance's security policy, as an administrator sets it.
 *
 * One action, because the policy is one decision with a qualifier and saving half
 * of it would leave a state nobody chose - a requirement on with nothing accepted
 * is an instance nobody can enter.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@polaris/db";
import { requireAdmin } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { recordAudit } from "@/lib/audit-service";
import { instanceSecuritySchema } from "@polaris/core";
import { phoneSenderReady } from "@/lib/messaging/code-senders";
import { getInstanceSecurity, setInstanceSecurity } from "@/lib/instance-security";
import { setPlayerAddressesShared } from "@/lib/player-address-policy";

/**
 * What the form sends: the policy, and whether the administrator accepted the risk
 * of turning the second step off. Who accepted it and when is never taken from the
 * request - the server writes that from the session that saved it.
 */
const saveInstanceSecurityInput = instanceSecuritySchema
    .omit({ secondFactorRiskAccepted: true })
    .extend({ acceptRisk: z.boolean().default(false) });

export async function saveInstanceSecurityAction(
    input: unknown
): Promise<{ error?: string; ok?: string }> {
    const admin = await requireAdmin();
    const t = await getTranslations("admin");
    const parsed = saveInstanceSecurityInput.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? t("security.errors.checkForm") };
    const { acceptRisk, ...chosen } = parsed.data;
    const previous = await getInstanceSecurity();

    // Turning the second step off leaves every account a password away from being
    // taken, so it is refused unless the administrator accepted that in words.
    // Saving anything else while it is already off keeps the acceptance on record.
    const turningOff = previous.requireSecondFactor && !chosen.requireSecondFactor;
    if (turningOff && !acceptRisk) return { error: t("security.errors.riskNotAccepted") };

    // Requiring a phone nobody can confirm would hold nobody and say it holds
    // everybody. Already on, it may stay on while the sender is fixed - the
    // guard lets through every account no code can reach in the meantime.
    if (chosen.requirePhone && !previous.requirePhone && !(await phoneSenderReady())) {
        return { error: t("security.phone.noChannel") };
    }

    // Requiring keys from an administrator who holds none would hold their own
    // next request on a step they may not be able to finish, and on an address
    // where passkeys do not work it would hold everybody's. Holding one proves
    // both that they can sign in and that keys work here.
    if (chosen.requirePhishingResistant !== "off") {
        const own = await prisma.passkey.count({ where: { userId: admin.id } });
        if (own === 0) return { error: t("security.phishing.needOwnKey") };
    }

    const secondFactorRiskAccepted = chosen.requireSecondFactor
        ? null
        : turningOff
          ? { by: admin.id, at: new Date().toISOString() }
          : previous.secondFactorRiskAccepted;
    await setInstanceSecurity({ ...chosen, secondFactorRiskAccepted });
    await recordAudit({
        actorId: admin.id,
        action: "instance.security.updated",
        metadata: {
            requireSecondFactor: chosen.requireSecondFactor,
            acceptedFactors: chosen.acceptedFactors,
            challengeConnectionSignIn: chosen.challengeConnectionSignIn,
            requireLoginApproval: chosen.requireLoginApproval,
            requirePhishingResistant: chosen.requirePhishingResistant,
            requirePhone: chosen.requirePhone,
            // Who accepted it is the actor; when is this entry's own time.
            ...(turningOff ? { secondFactorRiskAccepted: true } : {})
        }
    });
    revalidatePath("/admin/security");
    return { ok: t("security.saved") };
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
