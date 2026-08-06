"use server";

/**
 * What the confirmation dialog needs before somebody can prove themselves: the
 * ways this account is able to, and a code sent down whichever of them they
 * picked.
 *
 * Deliberately separate from the action being confirmed. Every destructive act
 * asks the same two questions and the dialog that asks them is one component, so
 * a screen that adds a confirmation gets the same behaviour rather than its own
 * near-copy of it - and the proof itself never travels through here. It goes
 * straight to the action it belongs to, which is the only place that knows what
 * it authorizes.
 */

import { z } from "zod";
import { requireUser } from "@/lib/session";
import { sendStepUpCode, stepUpOptions, type StepUpChoice } from "@/lib/step-up";
import { TWO_FACTOR_DELIVERY_METHODS, type TwoFactorDeliveryMethod } from "@polaris/core";

/**
 * What a code may be minted against.
 *
 * Kept to a shape rather than a list because the act names itself - `org-delete:
 * <id>` - and a registry of every purpose would be a second place to update
 * every time something becomes destructive. It only namespaces a code that is
 * already keyed to the account asking, so the worst a made-up purpose does is
 * mint a code that unlocks nothing.
 */
const purposeField = z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9:.\-]*$/, "Unknown confirmation");

const methodField = z.enum(TWO_FACTOR_DELIVERY_METHODS);

export async function stepUpOptionsAction(): Promise<{ choices: StepUpChoice[] }> {
    const user = await requireUser();
    const { choices } = await stepUpOptions(user.id);
    return { choices };
}

export async function sendStepUpCodeAction(purpose: unknown, method: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsedPurpose = purposeField.safeParse(purpose);
    const parsedMethod = methodField.safeParse(method);
    if (!parsedPurpose.success || !parsedMethod.success) return { error: "Could not send a code." };
    return sendStepUpCode(user.id, parsedPurpose.data, parsedMethod.data as TwoFactorDeliveryMethod);
}
