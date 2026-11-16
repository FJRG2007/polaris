/**
 * The steps a call walks, in order, and the model that walks them.
 *
 * 1. The model chosen, on each key held for its provider - the person's own
 *    in their order, then the deployment's when they may spend it.
 * 2. Whatever the caller adds after it: the person's fallback list
 *    (`routing.ts`), and for Automatic its own stand-ins.
 *
 * A key that has spent its own day or month allowance is left out; a key the
 * deployment shares is only a fallback while the administrator's ceilings
 * leave room. The plan is capped, because every step is a call a failing turn
 * may make.
 *
 * Server-only.
 */

import { spentKeys } from "@/lib/polar/router/limits";
import type { RouteReasoning } from "@/lib/polar/routing";
import { wrapLanguageModel, type LanguageModel } from "ai";
import type { PolarModelOption } from "@/lib/polar/models";
import type { ChatCredential } from "@/lib/agents/model-keys";
import type { FailureKind } from "@/lib/polar/provider-failure";
import { routeMiddleware, type RouteStep } from "@/lib/polar/router/chain";
import { isFreeModel, polarOutputTokens, type LanguageModelV4 } from "@/lib/polar/credit";

/** Most steps one call may walk. */
export const STEPS_MOST = 16;

/**
 * At most `most` of `steps`, in their order, keeping a place for every key:
 * a key's first step is always kept, and a further step of a key already
 * planned only while the keys still to come keep their place. A long list of
 * one provider's models can then never push the person's other providers out
 * of the plan. Pure.
 */
export function breadthFirst<T extends Pick<RouteStep, "provider" | "keyId">>(
    steps: readonly T[],
    most = STEPS_MOST
): T[] {
    if (steps.length <= most) return [...steps];
    const keyOf = (step: T) => step.keyId ?? `${step.provider}#`;
    const firsts = new Set<number>();
    const seenKeys = new Set<string>();
    for (const [index, step] of steps.entries()) {
        const key = keyOf(step);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        firsts.add(index);
    }
    let firstsLeft = Math.min(firsts.size, most);
    const kept: T[] = [];
    for (const [index, step] of steps.entries()) {
        if (kept.length >= most) break;
        if (firsts.has(index)) {
            if (firstsLeft === 0) continue;
            kept.push(step);
            firstsLeft--;
        } else if (kept.length + firstsLeft < most) {
            kept.push(step);
        }
    }
    return kept;
}

/** One step with what it was built from, so the caller can name who answered. */
export interface PlannedStep extends RouteStep {
    option: PolarModelOption;
    credential: ChatCredential;
}

/** A model to plan: the option, the keys it may spend, the effort it runs at. */
export interface PlanEntry {
    option: PolarModelOption;
    credentials: readonly ChatCredential[];
    reasoning?: RouteReasoning;
    /** Builds the AI SDK model for one key. */
    build: (credential: ChatCredential) => LanguageModel;
}

/** One step for one key. Its model is built once, when first asked. */
export function plannedStep(entry: PlanEntry, credential: ChatCredential): PlannedStep {
    let built: LanguageModel | null = null;
    return {
        option: entry.option,
        credential,
        model: () => (built ??= entry.build(credential)) as LanguageModelV4,
        modelId: entry.option.model,
        provider: entry.option.provider,
        free: isFreeModel(entry.option),
        reasoning: entry.option.reasoning,
        outputTokens: polarOutputTokens(entry.option),
        reads: entry.option,
        contextTokens: entry.option.providerContextTokens ?? entry.option.contextTokens,
        keyId: credential.keyId,
        limits: credential.limits,
        coolingUntil: credential.coolingUntil,
        coolingReason: credential.coolingReason,
        routeReasoning: entry.reasoning ?? "inherit"
    };
}

/**
 * The steps for these entries, in order: each entry's keys in theirs, minus
 * keys that spent their allowance, minus the deployment's keys when there is no
 * room on them (`sharedRoom`, asked once and only when such a key is a
 * fallback), minus a model on a key already planned. When every key of the
 * first entry is spent, its first key stays as a step that refuses at once, so
 * the turn says the key is at its limit rather than that it has none.
 */
export async function planSteps(
    entries: readonly PlanEntry[],
    sharedRoom: () => Promise<boolean>
): Promise<PlannedStep[]> {
    const spent = await spentKeys(entries.flatMap((entry) => entry.credentials));
    let room: boolean | null = null;
    const steps: PlannedStep[] = [];
    const seen = new Set<string>();
    for (const [position, entry] of entries.entries()) {
        for (const credential of entry.credentials) {
            const id = `${credential.keyId ?? credential.provider}/${entry.option.model}`;
            if (seen.has(id)) continue;
            if (credential.keyId && spent.has(credential.keyId)) continue;
            const first = position === 0 && steps.length === 0;
            if (credential.source === "instance" && !first) {
                room ??= await sharedRoom();
                if (!room) continue;
            }
            seen.add(id);
            steps.push(plannedStep(entry, credential));
        }
    }
    const lead = entries[0];
    if (steps.length === 0 && lead?.credentials[0]) {
        steps.push({ ...plannedStep(lead, lead.credentials[0]), spent: true });
    }
    return breadthFirst(steps);
}

/** The routed model for a plan, and how to ask who answered. */
export interface RoutedModel {
    model: LanguageModel;
    steps: readonly PlannedStep[];
    /** The step that answered, once one has. */
    answered: () => PlannedStep | null;
    /** The refusal that moved the call off the first step, when one did. */
    firstRefusal: () => FailureKind | null;
    /** Every refusal of the turn so far, in order, with the step it came from. */
    refusals: () => ReadonlyArray<{ step: PlannedStep; kind: FailureKind }>;
}

export function routedModel(
    steps: readonly PlannedStep[],
    onRefused?: (kind: FailureKind, step: PlannedStep) => void,
    firstYields = false
): RoutedModel {
    let answeredAt: number | null = null;
    let refusal: FailureKind | null = null;
    const trail: Array<{ step: PlannedStep; kind: FailureKind }> = [];
    const head = steps[0]!;
    // Wrapped even for one step: the router is also what cools a refused key
    // down, holds a key to its own allowance and notes the one that answered.
    const model = wrapLanguageModel({
        model: head.model(),
        middleware: routeMiddleware(steps, {
            firstYields,
            onAnswered: (index, first) => {
                answeredAt = index;
                refusal = first;
            },
            onRefused: (kind, index) => {
                refusal ??= kind;
                if (trail.length < STEPS_MOST * 2) trail.push({ step: steps[index]!, kind });
                onRefused?.(kind, steps[index]!);
            }
        })
    }) as LanguageModel;
    return {
        model,
        steps,
        answered: () => (answeredAt === null ? null : steps[answeredAt]!),
        firstRefusal: () => refusal,
        refusals: () => trail
    };
}
