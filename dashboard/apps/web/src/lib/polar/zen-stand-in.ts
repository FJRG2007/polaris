/**
 * OpenCode Zen's free tier as the last stand-in of a plan: when every model a
 * turn could use has refused, the turn is answered by a free model instead of
 * failing, unless an administrator switched the free tier off. It is offered
 * only to a person with no key of their own - somebody who brought one chose
 * where their prompts go - unless an administrator opts everybody in.
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

/** What the plan needs to know about the turn and the person. */
export interface StandInFacts {
    /** Whether the turn carries a file, so the model has to read one. */
    needsAttachment?: boolean;
    /** Whether the person holds a key of their own (`polarKeySources`). */
    ownKey: boolean;
}

/**
 * The free model and credential to end a plan on, or null when the free tier
 * is off, the person has a key of their own and nobody opted everyone in, its
 * list is empty, or the plan already ends on it.
 */
export async function zenLastStep(
    access: PolarAccess,
    lastProvider: string | null,
    { needsAttachment = false, ownKey }: StandInFacts
): Promise<{ option: PolarModelOption; credential: ReturnType<typeof zenCredential> } | null> {
    if (lastProvider === ZEN_FREE_SLUG) return null;
    if (ownKey && !access.zenStandInEveryone) return null;
    if (!(await zenFreeAllowed(access))) return null;
    const option = zenStandInModel(zenProviderOption(await zenFreeModels()).models, needsAttachment);
    return option ? { option, credential: zenCredential() } : null;
}
