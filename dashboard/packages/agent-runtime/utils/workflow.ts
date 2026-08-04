import { log } from "./cli.ts";
import type { OctokitWithPlugins } from "./github.ts";

interface ResolveRunParams {
  octokit: OctokitWithPlugins;
}

export interface ResolveRunResult {
  runId: number | undefined;
  jobId: string | undefined;
}

/**
 * Resolve GitHub Actions workflow run context.
 * Uses GITHUB_REPOSITORY and GITHUB_RUN_ID env vars.
 */
export async function resolveRun(params: ResolveRunParams): Promise<ResolveRunResult> {
  const runId = process.env.GITHUB_RUN_ID
    ? Number.parseInt(process.env.GITHUB_RUN_ID, 10)
    : undefined;
  const githubRepo = process.env.GITHUB_REPOSITORY;
  if (!githubRepo || !githubRepo.includes("/")) {
    throw new Error(`GITHUB_REPOSITORY env var must be set to "owner/repo", got: ${githubRepo}`);
  }
  const [owner, repo] = githubRepo.split("/");

  // jobId is purely cosmetic - only used to deep-link "View workflow run"
  // footers to the specific job. Tolerate any failure (e.g. test harness
  // running with the host's GITHUB_RUN_ID against a different repo's MCP
  // token, which 404s; this happens since #750 dropped the env allowlist
  // and now passes GITHUB_RUN_ID + GITHUB_JOB through to the test container)
  // and fall back to the run-level link.
  let jobId: string | undefined;
  const jobName = process.env.GITHUB_JOB;
  if (jobName && runId) {
    try {
      const jobs = await params.octokit.rest.actions.listJobsForWorkflowRun({
        owner,
        repo,
        run_id: runId,
      });
      const matchingJob = jobs.data.jobs.find((job) => job.name === jobName);
      if (matchingJob) {
        jobId = String(matchingJob.id);
        log.debug(`» found job ID: ${jobId}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.debug(`» listJobsForWorkflowRun failed (jobId stays undefined): ${msg}`);
    }
  }

  return { runId, jobId };
}
