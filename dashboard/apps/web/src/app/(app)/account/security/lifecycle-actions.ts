"use server";

/**
 * Shutting the account down, switching it off, and asking for it to be deleted.
 *
 * Kept apart from the rest of the Security actions for one reason: every export
 * in that file starts by refusing a device the account has not settled with, and
 * two of these must not. A lockdown that could not be lifted from the device that
 * raised it is a trap, and an account already shut down must still be able to
 * come back out.
 *
 * All three cost the account's strongest proof, which is `proveStepUp`: whatever
 * it actually armed, in the order it would be trusted, and never the password
 * when it has something better. An open session is not proof that the person at
 * it is the owner - the whole value of a stolen laptop is the sessions already on
 * it - and each of these is either irreversible or takes the account away from
 * whoever is holding it.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { proveStepUp } from "@/lib/step-up";
import { closeAccount, liftLockdown, raiseLockdown } from "@/lib/account-lifecycle";

type ActionResult = { error?: string };

const lockdownInput = core.lockdownSchema.extend({ proof: core.stepUpProofSchema });
const closeInput = z.object({
    closure: z.enum(core.ACCOUNT_CLOSURES),
    proof: core.stepUpProofSchema
});
const liftInput = z.object({ proof: core.stepUpProofSchema });

/**
 * Shut the account down.
 *
 * Proved rather than merely confirmed, because it is the one thing on the page
 * somebody presses when they already believe an attacker is holding a session -
 * and a dialog that only asks "are you sure" would be answered by that attacker
 * just as easily.
 *
 * No grant is taken for it: each of these is one deliberate act, and a two-minute
 * window on "delete my account" is a window that outlives the intent.
 */
export async function raiseLockdownAction(input: unknown): Promise<ActionResult> {
    const user = await requireUser();
    const parsed = lockdownInput.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };

    const proved = await proveStepUp(user.id, "lockdown", parsed.data.proof);
    if (proved.error) return proved;

    await raiseLockdown(user.id, parsed.data.note);
    revalidatePath("/account/security");
    return {};
}

/**
 * Lift it.
 *
 * The same proof going out as coming in, and deliberately not gated on anything
 * else: this is the way out, and a way out with a second lock on it is not one.
 */
export async function liftLockdownAction(input: unknown): Promise<ActionResult> {
    const user = await requireUser();
    const parsed = liftInput.safeParse(input);
    if (!parsed.success) return { error: "That could not be read." };

    const proved = await proveStepUp(user.id, "lockdown", parsed.data.proof);
    if (proved.error) return proved;

    await liftLockdown(user.id);
    revalidatePath("/account/security");
    return {};
}

/**
 * Switch the account off, or ask for it to be deleted.
 *
 * Both end every session including this one, so the browser is signed out on the
 * way back and there is nothing to revalidate.
 */
export async function closeAccountAction(input: unknown): Promise<ActionResult> {
    const user = await requireUser();
    const parsed = closeInput.safeParse(input);
    if (!parsed.success) return { error: "That could not be read." };

    const proved = await proveStepUp(user.id, "close-account", parsed.data.proof);
    if (proved.error) return proved;

    await closeAccount(user.id, parsed.data.closure);
    return {};
}
