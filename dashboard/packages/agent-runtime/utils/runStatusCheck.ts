/**
 * Single source of truth for the `polaris` commit-status check-run - the row a PR's
 * checks list shows while a run is in flight and after it ends.
 *
 * Polaris dispatches its workflow with `ref: <default branch>`, so the GitHub Actions
 * run attaches its check suite to the default branch head and never to the PR head.
 * Nothing about a run is therefore visible from the PR itself unless we post this
 * check-run against the PR head sha ourselves.
 *
 * Created `in_progress` by the server at dispatch - before the runner boots, and
 * upstream of every action-side failure that would otherwise leave the PR silent
 * (billing 402, token resolution, bad model slug, missing provider key). Moved to a
 * terminal conclusion by whichever of three actors reaches it first, all calling
 * `finalizeRunStatusCheck`:
 *
 *   1. the action at run end (`reportStatusChecks`)
 *   2. the `workflow_run.completed` webhook (covers cancel / SIGKILL / early throw)
 *   3. the hourly stuck-run reaper (covers a dropped webhook)
 *
 * That three-layer close-out is what makes an `in_progress` check safe here: a check
 * stranded `in_progress` on a required branch-protection rule would block merges
 * forever, which is why this file did not exist before.
 */

import { settingsLink } from "./apiUrl.ts";

/**
 * the run-lifecycle check. verdict-agnostic - it reports that a run happened, not what it
 * found.
 *
 * **DO NOT RENAME.** A check run has no separate display name, so this string is also the
 * context branch protection matches on. Renaming it on 2026-08-02 stopped the old context
 * reporting and blocked merges on four customer repos; it was reverted. Most installs'
 * branch protection is unreadable to us, so the blast radius cannot even be measured.
 * See wiki/review-approval.md.
 */
export const RUN_STATUS_CHECK_NAME = "polaris-agent";

/** the review-verdict check. opt-in, terminal-only, and deliberately separate from the above. */
export const APPROVAL_CHECK_NAME = "polaris-agent-approval";

/**
 * The terminal states we report. Exactly GitHub's check-run `conclusion` enum, which
 * happens to be `WorkflowRunStatus` minus `running` - so the server can map a finished
 * run's status straight across (`checkConclusionFromStatus` in utils/workflowRunStatus.ts).
 */
export type RunStatusCheckConclusion =
  | "success"
  | "failure"
  | "cancelled"
  | "timed_out"
  | "action_required"
  | "neutral"
  | "skipped"
  | "stale";

/**
 * Parse the on-the-wire `{ id: string }` shape (the form carried in `JsonPayload`) into
 * a check-run id. Mirrors `parseProgressComment` - returns undefined when the id isn't a
 * positive integer so callers can short-circuit cleanly.
 */
export function parseCheckRunId(raw: { id: string } | null | undefined): number | undefined {
  if (!raw?.id) return undefined;
  const id = parseInt(raw.id, 10);
  if (Number.isNaN(id) || id <= 0) return undefined;
  return id;
}

// minimal structural Octokit shape, matching the convention in progressComment.ts: the
// action package is on @octokit/rest v22 and the root project on v21, so a nominal type
// would clash. only the two methods used here are listed.
interface CheckRunResponse {
  data: { id: number };
}
type CheckRunStatus = "queued" | "in_progress" | "completed";
type CheckRunOutput = { title: string; summary: string };

// `details_url` is deliberately `?: string` and never `| undefined`: octokit types it
// that way and the action compiles with `exactOptionalPropertyTypes`, so it must be
// omitted rather than set to undefined. hence the conditional assignment below.
// a `type` (not `interface`) so it gains an implicit index signature and stays
// assignable to octokit's `RequestParameters & {...}` param.
type CreateCheckRunParams = {
  owner: string;
  repo: string;
  name: string;
  head_sha: string;
  status?: CheckRunStatus;
  conclusion?: RunStatusCheckConclusion;
  details_url?: string;
  output?: CheckRunOutput;
};
type UpdateCheckRunParams = {
  owner: string;
  repo: string;
  check_run_id: number;
  status?: CheckRunStatus;
  conclusion?: RunStatusCheckConclusion;
  details_url?: string;
  output?: CheckRunOutput;
};
export interface RunStatusCheckOctokit {
  rest: {
    checks: {
      create: (params: CreateCheckRunParams) => Promise<CheckRunResponse>;
      update: (params: UpdateCheckRunParams) => Promise<CheckRunResponse>;
      get: (params: {
        owner: string;
        repo: string;
        check_run_id: number;
      }) => Promise<{ data: { status: string } }>;
      listForRef: (params: {
        owner: string;
        repo: string;
        ref: string;
        check_name?: string;
        status?: "queued" | "in_progress" | "completed";
      }) => Promise<{ data: { check_runs: { id: number }[] } }>;
    };
  };
}

const IN_PROGRESS_OUTPUT = {
  title: "Polaris is running",
  summary: "Polaris is working on this pull request. This check updates when the run finishes.",
};

/**
 * Deep link to this repository's agent settings, appended to every non-success
 * summary so somebody whose merge is blocked by a check they never asked for can
 * reach the off switch from the check itself.
 */
function disableCheckLine(owner: string, repo: string): string {
  const link = settingsLink("Turn off this check", owner, repo);
  return `\n\n${link} - it reports run status only and gates nothing unless you required it in branch protection.`;
}

const TERMINAL_OUTPUT: Record<RunStatusCheckConclusion, { title: string; summary: string }> = {
  success: {
    title: "Polaris run completed",
    summary: "The Polaris run finished successfully.",
  },
  failure: {
    title: "Polaris run failed",
    summary: "The Polaris run failed. See the run logs for details.",
  },
  cancelled: {
    title: "Polaris run cancelled",
    summary: "The Polaris run was cancelled before it finished.",
  },
  timed_out: {
    title: "Polaris run timed out",
    summary: "The Polaris run exceeded its timeout. See the run logs for details.",
  },
  action_required: {
    title: "Polaris run needs attention",
    summary: "The Polaris run stopped and needs attention. See the run logs for details.",
  },
  neutral: {
    title: "Polaris run finished",
    summary: "The Polaris run finished without a pass or fail outcome.",
  },
  skipped: {
    title: "Polaris run skipped",
    summary: "This run was superseded by another Polaris run.",
  },
  stale: {
    title: "Polaris run didn't finish",
    summary:
      "Polaris never received a completion signal for this run. See the run logs for details.",
  },
};

/**
 * Terminal output for a conclusion. A non-success carries the console deep-link: that is the
 * moment a user is most likely to want the check gone, and a check whose only affordance is
 * "View details" gives them nowhere to go.
 */
function terminalOutput(params: {
  conclusion: RunStatusCheckConclusion;
  owner: string;
  repo: string;
  reviewUrl: string | undefined;
}): { title: string; summary: string } {
  const base = TERMINAL_OUTPUT[params.conclusion];
  // `details_url` can only carry one destination, so the rest go here - the summary is
  // rendered markdown in the check's detail panel. (Check-run `actions` are NOT links:
  // they are buttons that fire `check_run.requested_action`, so they cannot navigate.)
  const review = params.reviewUrl
    ? `\n\n[View the review Polaris posted →](${params.reviewUrl})`
    : "";
  const disable =
    params.conclusion === "success" ? "" : disableCheckLine(params.owner, params.repo);
  return { title: base.title, summary: base.summary + review + disable };
}

/**
 * Post the `in_progress` check-run on `headSha` and return its id for the finalizers.
 *
 * Best-effort: a transient 5xx, a repo that revoked `checks: write`, or a PR whose head
 * has already been deleted must never stop a run from dispatching. Returns undefined on
 * failure, which every caller treats as "no check to finalize".
 */
export async function createRunStatusCheck(params: {
  octokit: RunStatusCheckOctokit;
  owner: string;
  repo: string;
  headSha: string;
  detailsUrl: string | undefined;
}): Promise<number | undefined> {
  // reuse an in-flight check on this sha rather than adding a second identical row.
  // concurrent Polaris runs on one head are routine (an auto-review plus an @polaris
  // mention, say), and "is Polaris running on this commit?" has one answer, not two.
  // whichever run finishes first resolves it; the others re-PATCH the same conclusion.
  const existing = await params.octokit.rest.checks
    .listForRef({
      owner: params.owner,
      repo: params.repo,
      ref: params.headSha,
      check_name: RUN_STATUS_CHECK_NAME,
      status: "in_progress",
    })
    .catch(() => undefined);
  const reusable = existing?.data.check_runs[0];
  if (reusable) return reusable.id;

  const createParams: CreateCheckRunParams = {
    owner: params.owner,
    repo: params.repo,
    name: RUN_STATUS_CHECK_NAME,
    head_sha: params.headSha,
    status: "in_progress",
    output: IN_PROGRESS_OUTPUT,
  };
  if (params.detailsUrl) createParams.details_url = params.detailsUrl;
  const created = await params.octokit.rest.checks.create(createParams);
  return created.data.id;
}

/**
 * Move an existing check-run to its terminal conclusion.
 *
 * A PATCH, not a second create: `POST /check-runs` with the same name + sha creates a
 * SECOND row rather than replacing the first, so creating twice would show the PR two
 * contradictory `polaris` rows. (That is a real bug today - `finalizeSuccessRun` posts
 * success and a later throw posts failure, both as fresh rows.)
 */
export async function finalizeRunStatusCheck(params: {
  octokit: RunStatusCheckOctokit;
  owner: string;
  repo: string;
  checkRunId: number;
  conclusion: RunStatusCheckConclusion;
  detailsUrl: string | undefined;
  reviewUrl?: string | undefined;
}): Promise<void> {
  const updateParams: UpdateCheckRunParams = {
    owner: params.owner,
    repo: params.repo,
    check_run_id: params.checkRunId,
    status: "completed",
    conclusion: params.conclusion,
    output: terminalOutput({
      conclusion: params.conclusion,
      owner: params.owner,
      repo: params.repo,
      reviewUrl: params.reviewUrl,
    }),
  };
  if (params.detailsUrl) updateParams.details_url = params.detailsUrl;
  await params.octokit.rest.checks.update(updateParams);
}

/**
 * Post an already-terminal check-run in one call.
 *
 * The fallback for runs that never got a server-created check to update: a rolling
 * deploy where the dispatch payload predates `checkRun`, or a workflow invoked outside
 * Polaris's own dispatch path (`prompt_file`, a hand-written step).
 */
export async function createTerminalRunStatusCheck(params: {
  octokit: RunStatusCheckOctokit;
  owner: string;
  repo: string;
  headSha: string;
  conclusion: RunStatusCheckConclusion;
  detailsUrl: string | undefined;
  reviewUrl?: string | undefined;
}): Promise<void> {
  const createParams: CreateCheckRunParams = {
    owner: params.owner,
    repo: params.repo,
    name: RUN_STATUS_CHECK_NAME,
    head_sha: params.headSha,
    status: "completed",
    conclusion: params.conclusion,
    output: terminalOutput({
      conclusion: params.conclusion,
      owner: params.owner,
      repo: params.repo,
      reviewUrl: params.reviewUrl,
    }),
  };
  if (params.detailsUrl) createParams.details_url = params.detailsUrl;
  await params.octokit.rest.checks.create(createParams);
}

/**
 * Whether this check still needs finalizing.
 *
 * The server-side close-outs are BACKSTOPS: they exist for runs the action could not
 * finalize itself. Firing them unconditionally is actively harmful, because the action
 * writes a richer summary than they can - it knows the review URL, they do not - so a
 * blind re-PATCH silently strips that link seconds after it appears. It also resets
 * `completed_at`, discarding the duration GitHub renders as "Successful in 2m".
 *
 * Returns false when GitHub cannot be reached: a backstop that cannot confirm the check
 * is unfinished must not overwrite a good one.
 */
export async function runStatusCheckNeedsFinalizing(params: {
  octokit: RunStatusCheckOctokit;
  owner: string;
  repo: string;
  checkRunId: number;
}): Promise<boolean> {
  try {
    const existing = await params.octokit.rest.checks.get({
      owner: params.owner,
      repo: params.repo,
      check_run_id: params.checkRunId,
    });
    return existing.data.status !== "completed";
  } catch {
    return false;
  }
}
