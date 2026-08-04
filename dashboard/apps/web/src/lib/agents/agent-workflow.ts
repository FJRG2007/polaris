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

/** Where the file lands. Named for what it is rather than for Polaris, because it
 *  sits in somebody else's repository next to their own workflows. */
export const WORKFLOW_PATH = ".github/workflows/polaris-agent.yml";

/** Node major the runtime is built for. The runner's default is older. */
const NODE_VERSION = "24";

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
        run: node "$RUNNER_TEMP/agent-main.mjs"

      # Runs even when the step above was cancelled or timed out, which is the
      # only way state from a killed run is persisted at all.
      - name: Report back
        if: always()
        env:
          POLARIS_API_URL: ${input.apiUrl}
          POLARIS_RUN_ID: \${{ inputs.run_id }}
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
