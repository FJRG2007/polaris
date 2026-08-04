import { log } from "./cli.ts";
import { $ } from "./shell.ts";

type ComputeIncrementalDiffParams = {
  baseBranch: string;
  beforeSha: string;
  headSha: string;
};

/**
 * computes the incremental diff between two versions of a PR using range-diff
 * on virtual squash commits created via `git commit-tree`.
 *
 * each PR version is squashed into a single synthetic commit (merge-base → tip tree),
 * then range-diff compares those two single-commit ranges. this:
 * - isolates each version's net effect (base branch noise eliminated via per-version merge bases)
 * - avoids commit-matching issues that raw range-diff has with rebases/squashes/reordering
 * - creates only loose git objects, no branches or refs (unlike temp-branch squash approaches)
 *
 * unlike fetchAndFormatPrDiff/formatFilesWithLineNumbers, this output has no line numbers.
 * range-diff compares *patches* (diffs-of-diffs), not file trees - its hunk headers are
 * `@@ file.ts` breadcrumbs, not positional `@@ -X,Y +A,B @@` markers. reconstructing
 * line numbers would require cross-referencing with the v2 diff or content-matching against
 * file trees, both of which are fragile (duplicate lines, hunk boundary shifts after rebase).
 * a structured interdiff approach (diff two parsed patches, compare only +/- keys via Myers)
 * could approximate line numbers but loses semantic precision: range-diff understands patch
 * structure natively (rename detection, hunk-aware matching, dual-prefix inner/outer changes),
 * while flat key-sequence comparison can misalign duplicate lines and can't distinguish
 * "new addition to the PR" from "existing code newly modified by the PR". range-diff is the
 * right abstraction here - the incremental diff answers "how did the changeset evolve?",
 * not "where in the file is this?", and forcing positional line numbers onto it would be
 * semantically misleading.
 *
 * alternatives considered:
 * - plain git diff (two-tree or three-dot): includes base branch changes, no PR isolation
 * - patch-text diffing (interdiff / diff-of-diffs): fragile, hunk offset noise on rebase
 * - range-diff on raw commit ranges: confused by commit reorganization across force-pushes
 */
export type IncrementalDiffResult =
  /** range-diff ran and produced a delta */
  | { status: "ok"; diff: string }
  /** range-diff ran and the two versions are identical */
  | { status: "empty" }
  /** range-diff could not run - most often `beforeSha` has no ancestry to
   *  merge-base against on a shallow clone. distinct from "empty" on purpose:
   *  they were the same `null` before, so `checkout_pr` could not tell the
   *  agent whether there was nothing to see or whether we had simply failed.
   *  see #1139. */
  | { status: "unavailable"; reason: string };

export function computeIncrementalDiff(
  params: ComputeIncrementalDiffParams
): IncrementalDiffResult {
  try {
    // $1=beforeSha, $2=baseBranch, $3=headSha
    const raw = $(
      "sh",
      [
        "-c",
        'old_base=$(git merge-base "$1" "origin/$2") && ' +
          'new_base=$(git merge-base "$3" "origin/$2") && ' +
          "git range-diff --no-color " +
          '"$old_base..$(git commit-tree "$1^{tree}" -p "$old_base" -m x)" ' +
          '"$new_base..$(git commit-tree "$3^{tree}" -p "$new_base" -m x)"',
        "--",
        params.beforeSha,
        params.baseBranch,
        params.headSha,
      ],
      { log: false }
    );

    const processed = postProcessRangeDiff(raw);
    return processed === null ? { status: "empty" } : { status: "ok", diff: processed };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    // `log.warning`, not `log.debug`: debug is gated on LOG_LEVEL/ACTIONS_STEP_DEBUG,
    // neither of which is set in production - so 174 of 744 IncrementalReview runs
    // lost their incremental diff completely silently. see #1139.
    log.warning(`» incremental diff unavailable: range-diff failed: ${reason}`);
    return { status: "unavailable", reason };
  }
}

function isDiffPrefix(ch: string): boolean {
  return ch === " " || ch === "+" || ch === "-";
}

/**
 * transforms git range-diff output into a clean incremental diff.
 *
 * range-diff content lines have two prefix characters:
 *   1st (outer): range-diff level - space (same in both), + (new only), - (old only)
 *   2nd (inner): original diff level - space (context), + (added), - (removed)
 *
 * stripping the inner prefix produces a standard unified-diff-like output where
 * +/- means "changed between PR versions" rather than "changed vs base branch".
 *
 * uses a streaming approach: a ring buffer of before-context lines is flushed when
 * a change is hit, then afterCount lines of after-context are emitted directly.
 * nearest preceding ## / @@ headers are force-included when outside the context window.
 */
export function postProcessRangeDiff(raw: string, contextLines = 3): string | null {
  if (!raw.trim()) return null;
  if (/^\d+:\s+\w+\s+=\s+\d+:/m.test(raw)) return null;

  type Line = { prefix: string; from: number; to: number; seq: number };

  const beforeBuf: Line[] = [];
  let lastFileHdr: Line | null = null;
  let lastHunkHdr: Line | null = null;
  let fileHdrEmitted = true;
  let hunkHdrEmitted = true;

  let out = "";
  let afterRemaining = 0;
  let lastEmittedSeq = -2;
  let seq = 0;
  let hasChanges = false;

  function emit(line: Line) {
    if (lastEmittedSeq >= 0 && line.seq > lastEmittedSeq + 1) out += (out ? "\n" : "") + "...";
    out += (out ? "\n" : "") + line.prefix + raw.slice(line.from, line.to);
    lastEmittedSeq = line.seq;
    if (lastFileHdr?.seq === line.seq) fileHdrEmitted = true;
    if (lastHunkHdr?.seq === line.seq) hunkHdrEmitted = true;
  }

  function flushBefore() {
    if (lastFileHdr && !fileHdrEmitted) emit(lastFileHdr);
    if (lastHunkHdr && !hunkHdrEmitted) emit(lastHunkHdr);
    for (const line of beforeBuf) {
      if (line.seq > lastEmittedSeq) emit(line);
    }
    beforeBuf.length = 0;
  }

  let cursor = 0;
  while (cursor < raw.length) {
    const eol = raw.indexOf("\n", cursor);
    const lineEnd = eol === -1 ? raw.length : eol;

    if (raw.charCodeAt(cursor) >= 48 && raw.charCodeAt(cursor) <= 57) {
      cursor = lineEnd + 1;
      continue;
    }

    if (lineEnd - cursor >= 5 && raw.startsWith("    ", cursor)) {
      const prefix = raw[cursor + 4];
      if (isDiffPrefix(prefix)) {
        const contentPos = cursor + 5;
        const isOuterChange = prefix !== " ";
        let line: Line;
        let isChange = false;

        if (contentPos >= lineEnd) {
          line = { prefix, from: lineEnd, to: lineEnd, seq };
        } else if (isDiffPrefix(raw[contentPos])) {
          isChange = isOuterChange;
          line = { prefix, from: contentPos + 1, to: lineEnd, seq };
        } else {
          line = { prefix, from: contentPos, to: lineEnd, seq };
          if (
            raw.startsWith("## ", contentPos) &&
            !raw.startsWith("## Commit message", contentPos)
          ) {
            lastFileHdr = line;
            fileHdrEmitted = false;
            lastHunkHdr = null;
            hunkHdrEmitted = true;
          } else if (
            raw.startsWith("@@", contentPos) &&
            !raw.startsWith("@@ Metadata", contentPos)
          ) {
            lastHunkHdr = line;
            hunkHdrEmitted = false;
          }
        }

        if (isChange) {
          hasChanges = true;
          flushBefore();
          emit(line);
          afterRemaining = contextLines;
        } else if (afterRemaining > 0) {
          emit(line);
          afterRemaining--;
        } else {
          if (beforeBuf.length >= contextLines) beforeBuf.shift();
          beforeBuf.push(line);
        }

        seq++;
      }
    }

    cursor = lineEnd + 1;
  }

  return hasChanges ? out : null;
}
