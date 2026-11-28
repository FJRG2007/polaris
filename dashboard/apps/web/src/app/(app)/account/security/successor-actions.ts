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
import { anyStepUpProofSchema, proveStepUp } from "@/lib/step-up";
import { recordAudit } from "@/lib/audit-service";
import { newDeviceRefusal } from "@/lib/device-grace";
import { getTranslations } from "@/lib/i18n/request";
import { firstIssue, localized } from "./action-messages";
import { accountSuccessorSchema } from "@polaris/core";
import {
    clearSuccessor,
    lookupSuccessor,
    NAME_SUCCESSOR_PURPOSE,
    nameSuccessor,
    SuccessorError,
    type SuccessorLookup
} from "@/lib/successor-service";

type ActionResult = { error?: string };

/** What a successor code is minted against. One purpose for both directions:
 *  they are the same decision, and a code asked for to name somebody should not
 *  have to be asked for again to undo it a second later. */
const PURPOSE = "account-successor";

/** The account picked from the lookup, as well as what was typed to find it:
 *  the server resolves the typed text again and must land on the same account,
 *  so a client cannot name somebody the lookup never offered. */
const nameSuccessorSchema = accountSuccessorSchema.extend({
    userId: z.string().trim().min(1).max(64),
    proof: anyStepUpProofSchema
});

/** Who a typed identifier means, before anything is asked of the holder. */
export async function lookupSuccessorAction(identifier: unknown): Promise<SuccessorLookup> {
    const user = await requireUser();
    const parsed = accountSuccessorSchema.safeParse({ identifier });
    if (!parsed.success) return { kind: "none" };
    return lookupSuccessor(user.id, parsed.data.identifier);
}

export async function setSuccessorAction(input: unknown): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return localized({ error: blocked });

    const parsed = nameSuccessorSchema.safeParse(input);
    if (!parsed.success) return firstIssue(parsed.error.issues, "errors.checkForm");

    // Before the proof is checked: an add that cannot succeed is refused
    // without spending a code, and the caller's own id is refused whichever
    // identifier led to it.
    const found = await lookupSuccessor(user.id, parsed.data.identifier);
    if (found.kind === "self" || parsed.data.userId === user.id)
        return localized({ error: "Name somebody else - you cannot succeed yourself" });
    if (found.kind !== "match" || found.person.userId !== parsed.data.userId)
        return localized({ error: "No account matches that username, name or email address" });

    const proven = await proveStepUp(
        user.id,
        NAME_SUCCESSOR_PURPOSE + parsed.data.userId,
        parsed.data.proof
    );
    if (proven.error) return localized(proven);

    try {
        const successor = await nameSuccessor(user.id, parsed.data.userId);
        await recordAudit({
            actorId: user.id,
            action: "account.successor.set",
            targetType: "user",
            targetId: successor.userId
        });
        revalidatePath("/account/security", "layout");
        return {};
    } catch (caught) {
        if (caught instanceof SuccessorError) return localized({ error: caught.message });
        console.error("successor: could not name one:", caught);
        return { error: (await getTranslations("accountSecurity"))("errors.successorFailed") };
    }
}

export async function clearSuccessorAction(proof: unknown): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return localized({ error: blocked });

    const parsed = z.object({ proof: anyStepUpProofSchema }).safeParse(proof);
    if (!parsed.success) return { error: (await getTranslations("accountSecurity"))("errors.confirmFirst") };

    const proven = await proveStepUp(user.id, PURPOSE, parsed.data.proof);
    if (proven.error) return localized(proven);

    await clearSuccessor(user.id);
    await recordAudit({ actorId: user.id, action: "account.successor.cleared" });
    revalidatePath("/account/security", "layout");
    return {};
}
