import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ToolContext } from "../mcp/server.ts";
import { apiFetch } from "./apiFetch.ts";
import { log } from "./cli.ts";
import { MAX_LEARNINGS_LENGTH, truncateAtLineBoundary } from "./learningsTruncate.ts";

export { MAX_LEARNINGS_LENGTH, truncateAtLineBoundary };

/**
 * Repo-level learnings - operational facts about a repo (setup steps, test
 * commands, conventions, gotchas) that accumulate across agent runs and feed
 * back into future runs as durable context. Modeled on the PR-summary tmpfile
 * pattern (see action/utils/prSummary.ts):
 *
 *   1. server seeds `polaris-learnings.md` with the verbatim body of
 *      `Repo.learnings` (or empty for fresh repos), and parses headings
 *      server-side (`utils/learningsToc.ts`) - the parsed TOC is rendered
 *      into the LEARNINGS prompt section, not into the file
 *   2. the agent reads the TOC in the prompt and uses listed line ranges
 *      to read just the sections relevant to the current task - file can
 *      grow large, but only targeted ranges hit the agent's context
 *   3. agent edits the file in place at end-of-run during the reflection
 *      turn (see action/agents/postRun.ts buildLearningsReflectionPrompt)
 *   4. main.ts reads the file back at end-of-run and PATCHes
 *      `/api/repo/[owner]/[repo]/learnings` if the body changed
 *
 * Edit-in-place avoids stuffing the entire learnings list into both the
 * prompt context and an `update_learnings` MCP tool call (which previously
 * required passing the FULL merged list as a string parameter - an
 * output-token tax that grew linearly with the learnings size).
 *
 * Section structure is agent-curated. The reflection prompt teaches
 * hierarchy + a soft 300-line-per-section cap to keep TOC ranges
 * agent-targetable on long-lived repos; there is no fixed taxonomy.
 */

export const LEARNINGS_FILE_NAME = "polaris-learnings.md";
export const XREPO_LEARNINGS_FILE_NAME = "polaris-xrepo-learnings.md";

export function learningsFilePath(tmpdir: string): string {
  return join(tmpdir, LEARNINGS_FILE_NAME);
}

export function xrepoLearningsFilePath(tmpdir: string): string {
  return join(tmpdir, XREPO_LEARNINGS_FILE_NAME);
}

/** seed the rolling learnings tmpfile with the verbatim DB body (or empty
 * string for fresh repos). returns the absolute path. the parsed TOC is
 * carried separately via `RepoSettings.learningsHeadings` and rendered
 * into the prompt by `resolveInstructions`, so the file on disk is just
 * the body - no markers, no scaffold, no in-file TOC. */
export async function seedLearningsFile(params: {
  tmpdir: string;
  current: string | null;
}): Promise<string> {
  const path = learningsFilePath(params.tmpdir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, params.current ?? "", "utf8");
  return path;
}

/** seed the org-level cross-repo learnings tmpfile (--xrepo runs only). */
export async function seedXrepoLearningsFile(params: {
  tmpdir: string;
  current: string | null;
}): Promise<string> {
  const path = xrepoLearningsFilePath(params.tmpdir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, params.current ?? "", "utf8");
  return path;
}

/** read the agent-edited learnings file. returns null when the file is
 * missing or unreadable (treated as "no change"). caps content at the
 * server's max length to avoid a 400 round-trip. */
export async function readLearningsFile(path: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  return truncateAtLineBoundary(raw.trim(), MAX_LEARNINGS_LENGTH);
}

/**
 * Read the agent-edited repo-level learnings tmpfile and PATCH it to
 * `Repo.learnings`.
 *
 * Best-effort: any failure is logged and does not affect the run's success
 * status. Skips the PATCH when the file is byte-trim-identical to its seed -
 * the agent didn't touch it, so writing the same content back would just
 * burn a `LearningsRevision` row and an API round-trip.
 *
 * `ctx.toolState.model` is forwarded so `LearningsRevision.model` keeps
 * populating; it powers the per-revision attribution badge in the UI
 * history view.
 *
 * `learningsPersistAttempted` guards against double-execution between the
 * normal end-of-run path and the SIGINT/SIGTERM handler.
 */
export async function persistLearnings(ctx: ToolContext): Promise<void> {
  const filePath = ctx.toolState.learningsFilePath;
  if (!filePath) return;
  if (ctx.toolState.learningsPersistAttempted) return;
  ctx.toolState.learningsPersistAttempted = true;
  const current = await readLearningsFile(filePath);
  if (current === null) {
    log.debug(`learnings tmpfile missing or unreadable at ${filePath} - skipping persist`);
    return;
  }
  const seed = ctx.toolState.learningsSeed?.trim() ?? "";
  if (current === seed) {
    log.debug("learnings tmpfile unchanged from seed - skipping persist");
    return;
  }
  try {
    const response = await apiFetch({
      path: `/api/repo/${ctx.repo.owner}/${ctx.repo.name}/learnings`,
      method: "PATCH",
      headers: {
        authorization: `Bearer ${ctx.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        learnings: current,
        model: ctx.toolState.model,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const error = await response.text().catch(() => "(no body)");
      // promoted from debug → warning: this path means the agent edited the
      // file (we already short-circuited the unchanged-from-seed case above)
      // but the PATCH dropped it on the floor. silently losing real work is
      // worse than the noise of a CI warning.
      log.warning(`learnings persist failed (${response.status}): ${error}`);
      return;
    }
    log.info("» learnings updated");
  } catch (err) {
    log.warning(`learnings persist failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Read the agent-edited cross-repo learnings tmpfile and PATCH it to
 * `Account.xrepoLearnings`. Org-level analogue of `persistLearnings` -
 * same best-effort + unchanged-from-seed gating. Only seeded on --xrepo runs,
 * so this is a no-op when `xrepoLearningsFilePath` is unset.
 */
export async function persistXrepoLearnings(ctx: ToolContext): Promise<void> {
  const filePath = ctx.toolState.xrepoLearningsFilePath;
  if (!filePath) return;
  if (ctx.toolState.xrepoLearningsPersistAttempted) return;
  ctx.toolState.xrepoLearningsPersistAttempted = true;
  const current = await readLearningsFile(filePath);
  if (current === null) {
    log.debug(`xrepo learnings tmpfile missing or unreadable at ${filePath} - skipping persist`);
    return;
  }
  const seed = ctx.toolState.xrepoLearningsSeed?.trim() ?? "";
  if (current === seed) {
    log.debug("xrepo learnings tmpfile unchanged from seed - skipping persist");
    return;
  }
  try {
    const response = await apiFetch({
      path: `/api/account/${ctx.repo.owner}/xrepo-learnings`,
      method: "PATCH",
      headers: {
        authorization: `Bearer ${ctx.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ learnings: current, model: ctx.toolState.model }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const error = await response.text().catch(() => "(no body)");
      log.warning(`xrepo learnings persist failed (${response.status}): ${error}`);
      return;
    }
    log.info("» xrepo learnings updated");
  } catch (err) {
    log.warning(
      `xrepo learnings persist failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
