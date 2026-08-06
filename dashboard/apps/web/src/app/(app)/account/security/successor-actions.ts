"use server";

/**
 * Naming, and unnaming, the account that takes over this one.
 *
 * Behind the same confirmation as the acts a successor is able to perform, and
 * for the reason those acts have one at all: a session somebody else is sitting
 * at could otherwise name itself the successor and then use that to delete
 * everything the account owns, which would make the confirmation on the deleting
 * end decorative. Both directions are gated - removing a successor is a change to
 * who inherits an account, and letting a stolen session quietly do it is how the
 * real one finds out too late.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { proveStepUp } from "@/lib/step-up";
import { recordAudit } from "@/lib/audit-service";
import { newDeviceRefusal } from "@/lib/device-grace";
import { accountSuccessorSchema, stepUpProofSchema } from "@polaris/core";
import { clearSuccessor, setSuccessor, SuccessorError } from "@/lib/successor-service";

type ActionResult = { error?: string };

/** What a successor code is minted against. One purpose for both directions:
 *  they are the same decision, and a code asked for to name somebody should not
 *  have to be asked for again to undo it a second later. */
const PURPOSE = "account-successor";

const nameSuccessorSchema = accountSuccessorSchema.extend({ proof: stepUpProofSchema });

export async function setSuccessorAction(input: unknown): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };

    const parsed = nameSuccessorSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };

    const proven = await proveStepUp(user.id, PURPOSE, parsed.data.proof);
    if (proven.error) return proven;

    try {
        const successor = await setSuccessor(user.id, parsed.data.identifier);
        await recordAudit({
            actorId: user.id,
            action: "account.successor.set",
            targetType: "user",
            targetId: successor.userId
        });
        revalidatePath("/account/security");
        return {};
    } catch (caught) {
        if (caught instanceof SuccessorError) return { error: caught.message };
        console.error("successor: could not name one:", caught);
        return { error: "Could not name that successor." };
    }
}

export async function clearSuccessorAction(proof: unknown): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };

    const parsed = z.object({ proof: stepUpProofSchema }).safeParse(proof);
    if (!parsed.success) return { error: "Confirm it is you first." };

    const proven = await proveStepUp(user.id, PURPOSE, parsed.data.proof);
    if (proven.error) return proven;

    await clearSuccessor(user.id);
    await recordAudit({ actorId: user.id, action: "account.successor.cleared" });
    revalidatePath("/account/security");
    return {};
}
