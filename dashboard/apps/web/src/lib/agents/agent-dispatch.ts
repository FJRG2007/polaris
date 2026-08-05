/**
 * Starting a run, wherever it is configured to happen.
 *
 * One entry point for all three executions, because everything before the last
 * step is identical: open the run row, mint its token, and decide what the agent
 * is being asked to do. Only the final hand-off differs - a workflow dispatch for
 * the two GitHub schedules, a container for the one Polaris runs itself.
 *
 * A run row exists before any of that, so a dispatch GitHub refuses is a failed
 * run somebody can see rather than nothing at all.
 */

import { prisma } from "@polaris/db";
import { appBaseUrl } from "@/lib/domain-service";
import { githubAppInstallationToken } from "@/lib/github-service";
import { AGENT_WORKFLOW_PATH, type AgentExecution, type AgentTrigger } from "@polaris/core";
import { startServerRun } from "@/lib/agents/agent-server-executor";
import { createAgentRun, finishAgentRun } from "@/lib/agents/agent-run-service";
import {
    installWorkflow,
    renderWorkflow,
    resolveRunsOn,
    TIMEOUT_MINUTES
} from "@/lib/agents/agent-workflow";

export interface DispatchInput {
    /** The enabled repository row. */
    repo: {
        id: string;
        repoFullName: string;
        execution: string;
        poolId: string | null;
        model: string;
        installationId: string;
    };
    trigger: AgentTrigger;
    /** What the agent is being asked to do. For a webhook this is the event
     *  payload, which the runtime knows how to read; for a manual run it is the
     *  operator's own words. */
    prompt: string;
    mode?: string | null;
    issueNumber?: number | null;
    prNumber?: number | null;
    startedById?: string | null;
}

export interface DispatchResult {
    runId: string;
    error?: string;
}

/**
 * Open a run and hand it to whatever is going to execute it.
 *
 * A failure after the row exists closes the row out with the reason rather than
 * throwing it away: "GitHub refused the dispatch" is exactly the run somebody
 * needs to see, and a row that silently vanished would leave them looking for a
 * run that appears never to have been asked for.
 */
export async function dispatchRun(input: DispatchInput): Promise<DispatchResult> {
    const execution = input.repo.execution as AgentExecution;
    const { id: runId, token } = await createAgentRun({
        repoId: input.repo.id,
        trigger: input.trigger,
        execution,
        model: input.repo.model,
        mode: input.mode ?? null,
        issueNumber: input.issueNumber ?? null,
        prNumber: input.prNumber ?? null,
        startedById: input.startedById ?? null
    });

    try {
        if (execution === "server") {
            await startServerRun({ runId, runToken: token, repoFullName: input.repo.repoFullName, prompt: input.prompt });
        } else {
            await dispatchWorkflow({ ...input, runId, execution });
        }
        return { runId };
    } catch (caught) {
        const message = caught instanceof Error ? caught.message : "The run could not be started";
        await finishAgentRun(runId, { state: "failed", error: message });
        await prisma.agentRepo.update({ where: { id: input.repo.id }, data: { error: message } }).catch(() => undefined);
        return { runId, error: message };
    }
}

/**
 * Hand the run to GitHub Actions.
 *
 * The workflow is written first. It is idempotent and skips the commit when the
 * file already says what it should, so this is a cheap read on the common path
 * and the one thing that makes a repository whose settings just changed run with
 * the settings it just got.
 */
async function dispatchWorkflow(
    input: DispatchInput & { runId: string; execution: AgentExecution }
): Promise<void> {
    const [owner, repo] = input.repo.repoFullName.split("/");
    const token = await githubAppInstallationToken(owner);
    if (!token) {
        throw new Error(
            `Polaris has no GitHub App installation for ${owner}. An administrator connects one under Integrations.`
        );
    }

    const apiUrl = (await appBaseUrl()).replace(/\/+$/, "");
    const runsOn = await resolveRunsOn(input.execution, input.repo.poolId);
    const content = renderWorkflow({ apiUrl, runsOn, timeoutMinutes: TIMEOUT_MINUTES });

    const { changed } = await installWorkflow({ token, repoFullName: input.repo.repoFullName, content });
    if (changed) {
        await prisma.agentRepo.update({
            where: { id: input.repo.id },
            data: { workflowInstalledAt: new Date() }
        });
    }

    const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(
            AGENT_WORKFLOW_PATH.split("/").pop() ?? ""
        )}/dispatches`,
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
                "Content-Type": "application/json",
                "User-Agent": "polaris",
                "X-GitHub-Api-Version": "2022-11-28"
            },
            body: JSON.stringify({
                // Dispatched against the default branch. The agent checks out
                // whatever it actually needs once it is running, and a workflow
                // only GitHub can start has to be on a branch GitHub knows.
                ref: await defaultBranch(owner ?? "", repo ?? "", token),
                inputs: { prompt: input.prompt, run_id: input.runId }
            })
        }
    );

    if (!response.ok) {
        // A workflow file that has just been committed is not immediately
        // dispatchable: GitHub has to register it first. Saying so is the
        // difference between "try again in a moment" and "something is broken".
        if (response.status === 404) {
            throw new Error(
                changed
                    ? "GitHub has not registered the workflow file yet. It was just written, so try again in a moment."
                    : "GitHub could not find the agent workflow in this repository."
            );
        }
        throw new Error(`GitHub returned ${response.status} starting the workflow`);
    }
}

async function defaultBranch(owner: string, repo: string, token: string): Promise<string> {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "polaris",
            "X-GitHub-Api-Version": "2022-11-28"
        },
        cache: "no-store"
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status} reading the repository`);
    const body = (await response.json()) as { default_branch?: string };
    return body.default_branch || "main";
}
