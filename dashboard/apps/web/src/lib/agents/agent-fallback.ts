/**
 * Trying somewhere else when a provider will not serve the run.
 *
 * A run refused for the account's rate ceiling, an empty balance, a rejected
 * key, a model that no longer exists or a window it could not fit in is not a
 * run that failed at its work - it never started. Until now that was the end of
 * it, and somebody had to notice and re-point the repository by hand, which on
 * a webhook-triggered run means noticing that nothing happened.
 *
 * So the repository carries an ordered list of models to try instead, and a
 * refusal moves to the next one. Three things keep that from being a way to burn
 * runners:
 *
 *   - Only the refusals above. A hang or an unclassified failure may have left
 *     commits behind, and re-running one elsewhere is a guess that spends money
 *     to make it.
 *   - The chain is bounded, and each attempt records its number, so a chain that
 *     refuses all the way down stops at its end rather than at a timeout.
 *   - A candidate whose provider this account holds no key for is skipped rather
 *     than dispatched. Starting a job to be told there is no credential is a
 *     minute of runner to learn what was already known here.
 */

import { prisma } from "@polaris/db";
import { dispatchRun } from "@/lib/agents/agent-dispatch";
import { providersFor } from "@/lib/agents/user-model-keys";
import { providerForModel } from "@/lib/agents/agent-providers";
import { inheritedFallback } from "@/lib/agents/agent-defaults-service";
import { failureIsWorthRetrying, resolveModelChain, type AgentTrigger } from "@polaris/core";

/** What a decision to fall back produced, for the caller that wanted to know. */
export interface FallbackOutcome {
    /** The run that was started, when one was. */
    runId?: string;
    /** Why nothing was, in the words the run row already carries. Absent when a
     *  run started, and when there was simply nothing left to try. */
    reason?: string;
}

/**
 * Consider a failed run for a retry on the next model, and start one if there
 * is a next model to start it on.
 *
 * Safe to call on any finished run: everything that is not a provider refusal
 * returns immediately, and a repository with no chain configured is the common
 * case and costs one read.
 */
export async function considerFallback(runId: string): Promise<FallbackOutcome> {
    const run = await prisma.agentRun.findUnique({
        where: { id: runId },
        select: {
            id: true,
            state: true,
            model: true,
            attempt: true,
            failureKind: true,
            trigger: true,
            mode: true,
            issueNumber: true,
            prNumber: true,
            startedById: true,
            parentRunId: true,
            prompt: true,
            repo: {
                select: {
                    id: true,
                    ownerId: true,
                    repoFullName: true,
                    execution: true,
                    poolId: true,
                    model: true,
                    installationId: true,
                    enabled: true
                }
            }
        }
    });
    if (!run || run.state !== "failed" || !run.repo?.enabled) return {};
    if (!failureIsWorthRetrying(run.failureKind)) return {};

    const chain = await modelChainFor(run.repo.ownerId, run.repo.repoFullName, run.repo.model);
    // The chain starts at the repository's own model, so attempt 1 used index 0.
    // Anything past the end means every candidate has now refused.
    const remaining = chain.slice(run.attempt);
    if (remaining.length === 0) return {};

    const reachable = new Set(await providersFor(run.repo.ownerId));
    const next = remaining.find((candidate) => {
        const provider = providerForModel(candidate);
        // A raw specifier for a provider Polaris does not carry is somebody's
        // deliberate choice; it is not this module's place to refuse it.
        return !provider || reachable.has(provider.slug);
    });
    if (!next) {
        return { reason: "No model left in the fallback list has a provider key this account can use." };
    }

    const result = await dispatchRun({
        repo: { ...run.repo, model: next },
        trigger: run.trigger as AgentTrigger,
        prompt: run.prompt ?? "",
        mode: run.mode,
        issueNumber: run.issueNumber,
        prNumber: run.prNumber,
        startedById: run.startedById,
        // Counted from the candidate actually used, not from the last attempt
        // plus one: a candidate skipped for having no key never ran, and
        // charging the chain for it would cut it short.
        attempt: chain.indexOf(next) + 1,
        // The chain hangs off the first run, not off the one before it, so the
        // screen can gather a whole chain with one read.
        parentRunId: run.parentRunId ?? run.id
    });
    return result.error ? { reason: result.error } : { runId: result.runId };
}

/** The models to try for this repository, most preferred first. */
export async function modelChainFor(ownerId: string, repoFullName: string, model: string): Promise<string[]> {
    const tiers = await inheritedFallback(ownerId, repoFullName);
    return resolveModelChain(model, ...tiers);
}
