/**
 * Which model answers a Polar turn, and what it hands on to when it cannot.
 *
 * One answer for every place Polar is asked: the Polar panel, an `@polar` in a
 * chat or a task comment. They used to plan differently - a mention always went
 * to Automatic, which plans only keys, so a person whose Polar answered on their
 * own Claude subscription (or on the model they picked) got "I couldn't answer
 * that just now" in Chat while the panel answered fine.
 */

import { prisma } from "@polaris/db";
import type { PolarAccess } from "@/lib/polar/access";
import { polarRouting } from "@/lib/polar/router/store";
import type { TurnSignals } from "@/lib/polar/automatic";
import { polarAgentDefault } from "@/lib/polar/agents/defaults";
import { pinnedByHand, turnStandIns } from "@/lib/polar/turn-fallback";
import { agentTurnChoices, polarTurnChoices, type AgentWork } from "@/lib/polar/agents/shared";
import { automaticChoice, isAutomatic, modelChoiceSchema, type ModelChoice } from "@/lib/polar/shared";
import {
    followedBy,
    polarModelOptions,
    resolvePolarModel,
    sameModelElsewhere,
    type ModelRefusal,
    type ResolvedModel
} from "@/lib/polar/models";

export interface TurnPlan {
    resolved: ResolvedModel;
    /** The choice that resolved first. */
    choice: ModelChoice;
    /** The model asked for when it no longer exists and the first usable one stood in. */
    fellBackFrom: string | null;
}

/**
 * Plan a turn for `picked`: the agent's or Polar's own model list first, the
 * first usable model when the picked one is gone, then the same model through
 * another provider and the turn's stand-ins (`turn-fallback.ts`).
 */
export async function planPolarTurn(
    userId: string,
    picked: ModelChoice,
    signals: TurnSignals,
    access: PolarAccess,
    agent: AgentWork | null = null
): Promise<TurnPlan | ModelRefusal> {
    const polarWork = agent ? null : await polarAgentDefault(userId);
    const tries = agent ? agentTurnChoices(agent, picked) : polarTurnChoices(polarWork, picked);
    const listed = agent ?? polarWork;
    const keepsToList = listed?.modelPolicy === "required" && listed.models.length > 0;
    let choice: ModelChoice = tries[0] ?? picked;
    let resolved = await resolvePolarModel(userId, choice, signals, access);
    for (const next of tries.slice(1)) {
        if (typeof resolved !== "string") break;
        const attempt = await resolvePolarModel(userId, next, signals, access);
        if (typeof attempt !== "string") {
            choice = next;
            resolved = attempt;
        }
    }
    let fellBackFrom: string | null = null;
    if (resolved === "unknown_model" && !keepsToList) {
        const first = (await polarModelOptions(userId, access))[0]?.models[0];
        if (first) {
            fellBackFrom = choice.model;
            choice = { ...choice, provider: first.provider, model: first.model, payer: null };
            resolved = await resolvePolarModel(userId, choice, signals, access);
        }
    }
    if (typeof resolved === "string") return resolved;
    const routing = pinnedByHand(picked, choice) ? await polarRouting(userId) : null;
    const later = turnStandIns(
        picked,
        tries,
        choice,
        keepsToList,
        automaticChoice(choice.intelligence),
        routing?.pinnedFallsBack ?? true
    );
    const others: ResolvedModel[] = [];
    const twin = resolved.automatic ? null : await sameModelElsewhere(userId, resolved.option, access);
    if (twin) others.push(twin);
    for (const next of later) {
        const attempt = await resolvePolarModel(userId, next, signals, access);
        if (typeof attempt !== "string") others.push(attempt);
    }
    return { resolved: followedBy(userId, resolved, others), choice, fellBackFrom };
}

/**
 * The model this person last talked to Polar with, which is what the panel
 * opens on; Automatic when they never picked one. One indexed read.
 */
export async function lastPolarChoice(userId: string): Promise<ModelChoice> {
    try {
        const row = await prisma.polarThread.findFirst({
            where: { userId, NOT: { choice: { equals: null as never } } },
            orderBy: { updatedAt: "desc" },
            select: { choice: true }
        });
        const parsed = modelChoiceSchema.safeParse(row?.choice);
        if (parsed.success && parsed.data.kind === "language") return parsed.data;
    } catch (error) {
        console.error("polar: could not read the last model choice", error);
    }
    return automaticChoice();
}

export { isAutomatic };
