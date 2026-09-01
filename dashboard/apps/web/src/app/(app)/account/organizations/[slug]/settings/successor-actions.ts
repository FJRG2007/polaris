"use server";

/**
 * Naming, and unnaming, the account that takes over an organization.
 *
 * **Only the owner.** Not somebody holding `settings.manage`, not an
 * administrator. Every other setting on this screen is a decision about how the
 * organization is run and is delegated accordingly; this one is a decision about
 * what happens when the owner is gone, and a designation somebody else can write
 * is not a designation - it is a back door with a kind name. The same rule the
 * account's own successor follows, for the same reason.
 *
 * Behind the same confirmation as the act a successor is able to perform, and for
 * the reason that act has one: a session somebody else is sitting at could
 * otherwise name itself and then use that to delete the organization, which would
 * make the confirmation on the deleting end decorative. Both directions are gated
 * - removing one is a change to who inherits, and letting a stolen session
 * quietly do it is how the real owner finds out too late.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { proveStepUp } from "@/lib/step-up";
import { recordAudit } from "@/lib/audit-service";
import { stepUpProofSchema } from "@polaris/core";
import { newDeviceRefusal } from "@/lib/device-grace";
import { clearOrgSuccessor, setOrgSuccessor, SuccessorError } from "@/lib/successor-service";

type ActionResult = { error?: string };

/** What a code is minted against. One purpose for both directions: they are the
 *  same decision, and a code asked for to name somebody should not have to be
 *  asked for again to undo it a second later. */
const PURPOSE = "organization-successor";

const setSchema = z.object({
    orgId: z.string().uuid(),
    identifier: z.string().trim().min(1, "Say who").max(320),
    proof: stepUpProofSchema
});

const clearSchema = z.object({ orgId: z.string().uuid(), proof: stepUpProofSchema });

/**
 * Whether this account owns the organization, said as a refusal or nothing.
 *
 * A 404-shaped sentence for an organization the caller has no part in, matching
 * every other organization surface: one they are not in must not be confirmable
 * by poking at its settings.
 */
async function ownerOnly(userId: string, orgId: string): Promise<string | null> {
    const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { ownerId: true }
    });
    if (!org) return "That organization no longer exists";
    if (org.ownerId !== userId) {
        return "Only the owner can name who takes this organization over";
    }
    return null;
}

export async function setOrgSuccessorAction(input: unknown): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };

    const parsed = setSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };

    const refused = await ownerOnly(user.id, parsed.data.orgId);
    if (refused) return { error: refused };

    const proven = await proveStepUp(user.id, PURPOSE, parsed.data.proof);
    if (proven.error) return proven;

    try {
        const successor = await setOrgSuccessor(parsed.data.orgId, parsed.data.identifier);
        await recordAudit({
            actorId: user.id,
            orgId: parsed.data.orgId,
            action: "org.successor.set",
            targetType: "user",
            targetId: successor.userId
        });
        revalidatePath("/account/organizations");
        return {};
    } catch (caught) {
        if (caught instanceof SuccessorError) return { error: caught.message };
        console.error("successor: could not name one for an organization:", caught);
        return { error: "Could not name that successor." };
    }
}

export async function clearOrgSuccessorAction(input: unknown): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };

    const parsed = clearSchema.safeParse(input);
    if (!parsed.success) return { error: "Check the form." };

    const refused = await ownerOnly(user.id, parsed.data.orgId);
    if (refused) return { error: refused };

    const proven = await proveStepUp(user.id, PURPOSE, parsed.data.proof);
    if (proven.error) return proven;

    await clearOrgSuccessor(parsed.data.orgId);
    await recordAudit({
        actorId: user.id,
        orgId: parsed.data.orgId,
        action: "org.successor.cleared",
        targetType: "org",
        targetId: parsed.data.orgId
    });
    revalidatePath("/account/organizations");
    return {};
}
