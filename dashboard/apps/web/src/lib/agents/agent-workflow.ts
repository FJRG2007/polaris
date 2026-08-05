/**
 * The workflow Polaris writes into a repository, for the two executions GitHub
 * schedules.
 *
 * One file, and it only ever answers `workflow_dispatch`. Every decision about
 * when to run lives in Polaris: it receives the webhook, matches it against the
 * operator's automations, opens a run row, and then dispatches this. The
 * alternative - a second workflow carrying `if:` conditions - puts trigger logic
 * in the repository where it drifts from the screen that configured it, and
 * cannot be corrected without another commit.
 *
 * The runtime is fetched from this instance rather than referenced as a published
 * action, so the code a run executes is always the one this Polaris was built
 * with and no registry sits in the path. The digest the instance serves alongside
 * it is checked before it is executed, so a truncated download or anything
 * rewriting the response in flight fails the job instead of running.
 *
 * `server` execution installs nothing: it needs no workflow at all.
 */

import { Buffer } from "node:buffer";
import { prisma } from "@polaris/db";
import { AGENT_EXECUTIONS, AGENT_WORKFLOW_PATH, needsWorkflowFile, type AgentExecution } from "@polaris/core";
import { appBaseUrl } from "@/lib/domain-service";
import { parseLabels } from "@/lib/runners/runner-labels";
import { githubAppInstallationToken } from "@/lib/github-service";

/** Where the file lands. Defined in @polaris/core so a screen can link to it
 *  without importing this module, which reads the database and mints tokens. */
const WORKFLOW_PATH = AGENT_WORKFLOW_PATH;

/** Node major the runtime is built for. The runner's default is older. */
const NODE_VERSION = "24";

/** Ceiling on one run. The runtime has its own, lower by default; this is the
 *  backstop that stops a wedged job holding a runner for a day. */
export const TIMEOUT_MINUTES = 60;

export interface WorkflowInput {
    /** Where the run reports back to. Baked in rather than passed per dispatch so
     *  a job that fails before it reads its inputs still knows where to complain. */
    apiUrl: string;
    /** `runs-on` for the job: GitHub-hosted, or a pool's labels. */
    runsOn: readonly string[];
    /** Ceiling on one run, in minutes. */
    timeoutMinutes: number;
}

/** The managed header. Anybody opening the file should know editing it is futile
 *  before they read the rest. */
const HEADER = `# Managed by Polaris. Any edit is overwritten the next time the
# repository's agent settings change. Configure it under Apps > Agents.`;

export function renderWorkflow(input: WorkflowInput): string {
    const runsOn = input.runsOn.length === 1 ? input.runsOn[0] : `[${input.runsOn.join(", ")}]`;

    return `${HEADER}
name: Polaris Agent

on:
  workflow_dispatch:
    inputs:
      prompt:
        description: What the agent was asked to do
        type: string
        required: true
      run_id:
        description: The Polaris run this job belongs to
        type: string
        required: false

# Deliberately minimal. The agent does not work with this token: it exchanges the
# job's OIDC identity for a scoped installation token from Polaris, so what the
# workflow itself holds never needs to be more than read access.
permissions:
  contents: read
  id-token: write

jobs:
  agent:
    runs-on: ${runsOn}
    timeout-minutes: ${input.timeoutMinutes}
    steps:
      - name: Check out the repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 1

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: "${NODE_VERSION}"

      - name: Fetch the agent runtime
        env:
          POLARIS_API_URL: ${input.apiUrl}
        run: |
          set -euo pipefail
          for part in main post; do
            curl -fsSL --retry 3 --retry-all-errors \\
              -D "$RUNNER_TEMP/headers-$part" \\
              -o "$RUNNER_TEMP/agent-$part.mjs" \\
              "$POLARIS_API_URL/api/agents/runtime/bundle?part=$part"
            expected=$(awk 'tolower($1) == "x-content-sha256:" { print $2 }' "$RUNNER_TEMP/headers-$part" | tr -d '\\r')
            actual=$(sha256sum "$RUNNER_TEMP/agent-$part.mjs" | cut -d " " -f 1)
            if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
              echo "::error::The agent runtime Polaris served does not match the digest it published. Refusing to run it."
              exit 1
            fi
          done

      - name: Run the agent
        env:
          POLARIS_API_URL: ${input.apiUrl}
          INPUT_PROMPT: \${{ inputs.prompt }}
          POLARIS_RUN_ID: \${{ inputs.run_id }}
          # The runtime requires a token to exist before it does anything, and the
          # job's own is the one it can legitimately have. It is NOT what
          # authenticates the run to Polaris: that is the OIDC assertion the
          # runtime mints and sends alongside, which Polaris verifies against
          # GitHub's published keys. A real Polaris credential is handed back in
          # the run-context reply, because a workflow input would be readable by
          # anybody who can see the Actions tab.
          INPUT_TOKEN: \${{ github.token }}
        run: node "$RUNNER_TEMP/agent-main.mjs"

      # Runs even when the step above was cancelled or timed out, which is the
      # only way state from a killed run is persisted at all.
      - name: Report back
        if: always()
        env:
          POLARIS_API_URL: ${input.apiUrl}
          POLARIS_RUN_ID: \${{ inputs.run_id }}
          INPUT_TOKEN: \${{ github.token }}
        run: node "$RUNNER_TEMP/agent-post.mjs"
`;
}

/**
 * Write the workflow into the repository, or leave it alone when it already says
 * what it should.
 *
 * Comparing before writing matters more than it looks: every write is a commit on
 * the default branch of somebody's repository, and a settings screen that commits
 * on every save turns into noise in their history.
 */
export async function installWorkflow(params: {
    token: string;
    repoFullName: string;
    content: string;
}): Promise<{ changed: boolean }> {
    const [owner, repo] = params.repoFullName.split("/");
    const path = `https://api.github.com/repos/${owner}/${repo}/contents/${WORKFLOW_PATH}`;
    const headers = {
        Authorization: `Bearer ${params.token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "polaris",
        "X-GitHub-Api-Version": "2022-11-28"
    };

    const existing = await fetch(path, { headers, cache: "no-store" });
    let sha: string | undefined;
    if (existing.ok) {
        const body = (await existing.json()) as { sha?: string; content?: string };
        sha = body.sha;
        const current = Buffer.from(body.content ?? "", "base64").toString("utf8");
        if (current === params.content) return { changed: false };
    } else if (existing.status !== 404) {
        throw new Error(`GitHub returned ${existing.status} reading the workflow file`);
    }

    const write = await fetch(path, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
            message: sha ? "Update the Polaris agent workflow" : "Add the Polaris agent workflow",
            content: Buffer.from(params.content, "utf8").toString("base64"),
            ...(sha ? { sha } : {})
        })
    });
    if (!write.ok) {
        const detail = await write.text().catch(() => "");
        // The one failure worth naming: an App without `workflows: write` can read
        // and write every other file and is refused on this one alone.
        if (write.status === 403 && detail.includes("workflow")) {
            throw new Error(
                "GitHub refused the workflow file. The App needs the Workflows permission, which an administrator accepts under Integrations."
            );
        }
        throw new Error(`GitHub returned ${write.status} writing the workflow file`);
    }
    return { changed: true };
}

/**
 * Bring the repository's workflow file in line with how it is configured.
 *
 * Called when the settings change, not only when a run is dispatched. A
 * repository somebody added for GitHub Actions has to look configured in GitHub
 * the moment they add it: with the file written only at dispatch, the operator
 * sees nothing in their repository, and the first run then races GitHub
 * registering a file that was committed seconds earlier.
 *
 * It also does the other half, which nothing did before: a repository moved to
 * `server`, disabled, or removed has its workflow taken back out. A file left
 * behind is a workflow anybody can still start by hand from the Actions tab,
 * against a repository Polaris no longer considers enabled.
 *
 * Returns what went wrong rather than throwing. Saving the settings and writing
 * the file are two different things, and a GitHub that refused the second must
 * not roll back the first - the settings are correct, the repository just does
 * not carry them yet, which is exactly what `AgentRepo.error` is for.
 */
export async function syncRepoWorkflow(params: {
    repoId: string;
    repoFullName: string;
    execution: AgentExecution;
    poolId: string | null;
    enabled: boolean;
}): Promise<{ error?: string }> {
    const owner = params.repoFullName.split("/")[0] ?? "";
    // `server` runs need no workflow at all, and a disabled repository should not
    // carry one it could still be started from.
    const wanted = params.enabled && needsWorkflowFile(params.execution);

    const token = await githubAppInstallationToken(owner).catch(() => null);
    if (!token) {
        const error = `Polaris has no GitHub App installation for ${owner}, so it cannot write the workflow file.`;
        await stamp(params.repoId, { error });
        return { error };
    }

    try {
        if (!wanted) {
            await removeWorkflow({ token, repoFullName: params.repoFullName });
            await stamp(params.repoId, { workflowInstalledAt: null, error: null });
            return {};
        }
        const apiUrl = (await appBaseUrl()).replace(/\/+$/, "");
        const content = renderWorkflow({
            apiUrl,
            runsOn: await resolveRunsOn(params.execution, params.poolId),
            timeoutMinutes: TIMEOUT_MINUTES
        });
        await installWorkflow({ token, repoFullName: params.repoFullName, content });
        // Stamped whether or not the file needed writing: this records when
        // Polaris last confirmed it is in place, which is the question the screen
        // asks. Stamping only on a write would leave a repository whose file was
        // already correct looking permanently uninstalled, and the reconcile
        // below would re-check it on every page load forever.
        await stamp(params.repoId, { workflowInstalledAt: new Date(), error: null });
        return {};
    } catch (caught) {
        const error = caught instanceof Error ? caught.message : "Could not write the workflow file";
        await stamp(params.repoId, { error });
        return { error };
    }
}

async function stamp(repoId: string, data: { workflowInstalledAt?: Date | null; error?: string | null }): Promise<void> {
    await prisma.agentRepo.update({ where: { id: repoId }, data }).catch(() => undefined);
}

/**
 * Put right any repository whose workflow file is not where its settings say it
 * should be.
 *
 * Every path that changes the settings writes the file itself, so on a healthy
 * instance this matches nothing and costs one indexed query. It exists for the
 * two cases that path cannot cover: a repository configured before Polaris wrote
 * the file at all, and one whose write failed at the time - GitHub was down, the
 * App had not been granted `workflows`, the permission was accepted afterwards.
 * Both leave a repository that looks configured and would fail at its first run,
 * and neither is something an operator should have to notice and fix by hand.
 *
 * Reconciled where the repositories are listed, because that is the screen that
 * shows the discrepancy. Bounded so a long list of broken repositories cannot
 * turn one page render into a hundred GitHub calls; the rest are picked up on
 * the next visit.
 */
const RECONCILE_LIMIT = 5;

export async function reconcileRepoWorkflows(ownerId: string): Promise<number> {
    const stale = await prisma.agentRepo.findMany({
        where: {
            ownerId,
            enabled: true,
            workflowInstalledAt: null,
            execution: { in: AGENT_EXECUTIONS.filter(needsWorkflowFile) }
        },
        select: { id: true, repoFullName: true, execution: true, poolId: true },
        take: RECONCILE_LIMIT
    });
    if (stale.length === 0) return 0;

    const results = await Promise.all(
        stale.map((repo) =>
            syncRepoWorkflow({
                repoId: repo.id,
                repoFullName: repo.repoFullName,
                execution: repo.execution as AgentExecution,
                poolId: repo.poolId,
                enabled: true
            })
        )
    );
    return results.filter((result) => !result.error).length;
}

/**
 * What the job asks to run on.
 *
 * GitHub-hosted for `actions`; the pool's own labels for `runners`, which is the
 * only difference between the two.
 */
export async function resolveRunsOn(execution: AgentExecution, poolId: string | null): Promise<string[]> {
    if (execution !== "runners" || !poolId) return ["ubuntu-latest"];
    const pool = await prisma.runnerPool.findUnique({ where: { id: poolId }, select: { labels: true } });
    const labels = pool ? parseLabels(pool.labels) : [];
    if (labels.length === 0) {
        throw new Error("The runner pool this repository uses has no labels, so no job could ever land on it.");
    }
    return ["self-hosted", ...labels];
}

/** Remove the workflow when a repository stops using an execution that needs one.
 *  A file left behind is a workflow somebody can still start by hand, against a
 *  repository Polaris no longer considers enabled. */
export async function removeWorkflow(params: { token: string; repoFullName: string }): Promise<void> {
    const [owner, repo] = params.repoFullName.split("/");
    const path = `https://api.github.com/repos/${owner}/${repo}/contents/${WORKFLOW_PATH}`;
    const headers = {
        Authorization: `Bearer ${params.token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "polaris",
        "X-GitHub-Api-Version": "2022-11-28"
    };
    const existing = await fetch(path, { headers, cache: "no-store" });
    if (!existing.ok) return;
    const body = (await existing.json()) as { sha?: string };
    if (!body.sha) return;
    await fetch(path, {
        method: "DELETE",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Remove the Polaris agent workflow", sha: body.sha })
    });
}
