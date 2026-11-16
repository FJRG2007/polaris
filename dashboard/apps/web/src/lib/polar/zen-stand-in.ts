/**
 * OpenCode Zen's free tier as the last stand-in of a plan: when every model a
 * turn could use has refused, the turn is answered by a free model instead of
 * failing, unless an administrator switched the free tier off.
 *
 * Kept apart from the router so the plan code only appends what this returns.
 *
 * Server-only.
 */

import { ZEN_FREE_SLUG } from "@/lib/polar/shared";
import type { PolarModelOption } from "@/lib/polar/models";
import { zenFreeAllowed, type PolarAccess } from "@/lib/polar/access";
import { zenCredential, zenFreeModels, zenProviderOption } from "@/lib/polar/zen-free";

/** The free model a plan ends on: the first Zen lists that reads what the turn
 *  carries, else the first one. Null when the list is empty. Pure. */
export function zenStandInModel(
    models: readonly PolarModelOption[],
    needsAttachment: boolean
): PolarModelOption | null {
    return (needsAttachment ? models.find((model) => model.attachment) : undefined) ?? models[0] ?? null;
}

/**
 * The free model and credential to end a plan on, or null when the free tier
 * is off, its list is empty, or the plan already ends on it.
 */
export async function zenLastStep(
    access: PolarAccess,
    lastProvider: string | null,
    needsAttachment = false
): Promise<{ option: PolarModelOption; credential: ReturnType<typeof zenCredential> } | null> {
    if (lastProvider === ZEN_FREE_SLUG) return null;
    if (!(await zenFreeAllowed(access))) return null;
    const option = zenStandInModel(zenProviderOption(await zenFreeModels()).models, needsAttachment);
    return option ? { option, credential: zenCredential() } : null;
}
