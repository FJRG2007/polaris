import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ToolContext } from "../mcp/server.ts";
import { apiFetch } from "./apiFetch.ts";
import { log } from "./cli.ts";
import { patchWorkflowRunFields } from "./patchWorkflowRunFields.ts";

/**
 * The PR-level summary snapshot is a markdown file the agent edits in place
 * during a Review / IncrementalReview run. The server seeds the file with
 * either the previous run's snapshot (incremental) or a stub scaffold (first
 * run), lets the agent edit it with its native file-editing tools, then
 * reads it back at end-of-run and persists it to `WorkflowRun.summarySnapshot`.
 *
 * The snapshot is an internal artifact - it is consumed by future agent runs
 * as durable cross-run context, not surfaced to humans. User-visible summary
 * content lives in the Review / IncrementalReview review bodies, governed by
 * `action/modes.ts`.
 *
 * Edit-in-place avoids the output-token tax of a tool call that regurgitates
 * the full snapshot, and gives incremental runs a clean surface that
 * range-diffs cleanly across runs because the section headings are stable.
 */

export const SUMMARY_FILE_NAME = "polaris-summary.md";

/**
 * minimal seed for first-run PRs. just a header + a one-line note about
 * what this file is for. structure is intentionally NOT prescribed -
 * different PRs warrant different organization, and the agent should pick
 * a shape that fits this PR. the agent's prompt (see selectMode.ts
 * `buildSummaryAddendum`) carries the actual instructions for what to
 * capture and how.
 *
 * keeping the seed short also makes the unchanged-from-seed gate more
 * sensitive - any meaningful edit moves the file off the seed, so
 * `persistSummary` can reliably skip the DB write when the agent didn't
 * touch the file.
 */
export const SUMMARY_SCAFFOLD = `# PR summary

<!-- durable cross-run context. edit in place; the next agent run reads this
     before reviewing new commits. structure however serves the PR best. -->
`;

const MIN_SNAPSHOT_LENGTH = 60;
/** PG TEXT can hold ~1GB but a sane cap protects the DB / API payloads. */
const MAX_SNAPSHOT_LENGTH = 32_768;

export function summaryFilePath(tmpdir: string): string {
  return join(tmpdir, SUMMARY_FILE_NAME);
}

/** seed the summary file with previous snapshot (incremental) or scaffold (first run). */
export async function seedSummaryFile(params: {
  tmpdir: string;
  previousSnapshot: string | null;
}): Promise<string> {
  const path = summaryFilePath(params.tmpdir);
  await mkdir(dirname(path), { recursive: true });
  const seed =
    params.previousSnapshot && params.previousSnapshot.trim().length >= MIN_SNAPSHOT_LENGTH
      ? params.previousSnapshot
      : SUMMARY_SCAFFOLD;
  await writeFile(path, seed, "utf8");
  return path;
}

/** read + validate the summary file written by the agent.
 * returns null when the file is missing or fails sanity checks. */
export async function readSummaryFile(path: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length < MIN_SNAPSHOT_LENGTH) return null;
  if (trimmed.length > MAX_SNAPSHOT_LENGTH) return trimmed.slice(0, MAX_SNAPSHOT_LENGTH);
  return trimmed;
}

/**
 * Fetch the most recent persisted PR summary snapshot for this PR.
 * Returns null on first-time PRs, when summary is disabled, or on any error.
 * Best-effort: a transient API failure should not block the run.
 */
export async function fetchPreviousSnapshot(
  ctx: ToolContext,
  prNumber: number
): Promise<string | null> {
  if (!ctx.githubInstallationToken) return null;
  try {
    const response = await apiFetch({
      path: `/api/repo/${ctx.repo.owner}/${ctx.repo.name}/pr/${prNumber}/summary-comment`,
      method: "GET",
      headers: { authorization: `Bearer ${ctx.githubInstallationToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { snapshot?: string | null };
    return typeof data.snapshot === "string" && data.snapshot.length > 0 ? data.snapshot : null;
  } catch {
    return null;
  }
}

/**
 * Read the agent-edited PR summary tmpfile and persist to
 * `WorkflowRun.summarySnapshot`.
 *
 * Best-effort: any failure is logged and does not affect the run's success
 * status. Skips the PATCH when the file is byte-identical to its seed -
 * persisting the seed verbatim would either re-write what the DB already has
 * (on incremental runs) or serialize the placeholder scaffold (on first
 * runs), neither of which is useful.
 *
 * Funnels through both the success path and the SIGINT/SIGTERM handler;
 * `summaryPersistAttempted` guards against double-execution.
 */
export async function persistSummary(ctx: ToolContext): Promise<void> {
  const filePath = ctx.toolState.summaryFilePath;
  if (!filePath) return;
  if (ctx.toolState.summaryPersistAttempted) return;
  ctx.toolState.summaryPersistAttempted = true;
  const snapshot = await readSummaryFile(filePath);
  if (!snapshot) {
    log.debug(`pr summary tmpfile missing or invalid at ${filePath} - skipping persist`);
    return;
  }
  // soft gate: agent never touched the seeded file. saving the seed back
  // is a no-op at best (incremental run - DB already has it) and a bug at
  // worst (first run - serializes the placeholder italics). log a warning
  // so the failure mode is visible in CI without flipping the run to
  // failed.
  const seed = ctx.toolState.summarySeed?.trim();
  if (seed !== undefined && snapshot === seed) {
    log.warning(
      "» pr summary tmpfile unchanged from seed - skipping persist (agent did not edit it)"
    );
    return;
  }
  await patchWorkflowRunFields(ctx, { summarySnapshot: snapshot }).catch((err) => {
    log.debug(`pr summary persist failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}
