import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";
import { type } from "arktype";
import { resolveBodyAssets } from "../utils/body.ts";
import { stripExistingFooter } from "../utils/buildPolarisFooter.ts";
import { log } from "../utils/log.ts";
import * as yes from "../yes/index.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

// GraphQL query to fetch all review threads for a PR with full comment history
export const REVIEW_THREADS_QUERY = `
query ($owner: String!, $name: String!, $prNumber: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $prNumber) {
      reviewThreads(first: 100) {
        nodes {
          id
          path
          line
          startLine
          diffSide
          isResolved
          isOutdated
          comments(first: 50) {
            nodes {
              fullDatabaseId
              body
              bodyHTML
              createdAt
              diffHunk
              line
              startLine
              originalLine
              originalStartLine
              author { login }
              pullRequestReview {
                databaseId
                author { login }
              }
              reactionGroups {
                content
                reactors(first: 10) {
                  nodes {
                    ... on Actor { login }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
`;

export type ReviewThreadComment = {
  fullDatabaseId: string | null;
  body: string;
  bodyHTML: string;
  createdAt: string;
  diffHunk: string;
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  originalStartLine: number | null;
  author: { login: string } | null;
  pullRequestReview: {
    databaseId: number | null;
    author: { login: string } | null;
  } | null;
  reactionGroups: Array<{
    content: string;
    reactors: { nodes: Array<{ login: string } | null> | null } | null;
  }> | null;
};

export type ReviewThread = {
  id: string;
  path: string;
  line: number | null;
  startLine: number | null;
  diffSide: "LEFT" | "RIGHT";
  isResolved: boolean;
  isOutdated: boolean;
  comments: {
    nodes: (ReviewThreadComment | null)[] | null;
  } | null;
};

export type ReviewThreadsQueryResponse = {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: (ReviewThread | null)[] | null;
      } | null;
    } | null;
  } | null;
};

export function countLines(str: string): number {
  let count = 1;
  let index = -1;
  // biome-ignore lint/suspicious/noAssignInExpressions: assignment in while condition is intentional for indexOf loop pattern
  while ((index = str.indexOf("\n", index + 1)) !== -1) {
    count++;
  }
  return count;
}

// extract exactly the commented line range from diffHunk, plus context
const CONTEXT_PADDING = 3;

function extractCommentedLines(
  diffHunk: string,
  startLine: number | null,
  endLine: number | null,
  side: "LEFT" | "RIGHT"
): string {
  const lines = diffHunk.split("\n");
  if (lines.length <= 1) return diffHunk;

  const header = lines[0];
  const contentLines = lines.slice(1);

  // parse header: @@ -old_start,old_count +new_start,new_count @@
  const headerMatch = header.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!headerMatch) return diffHunk;

  const hunkOldStart = parseInt(headerMatch[1], 10);
  const hunkNewStart = parseInt(headerMatch[2], 10);

  // LEFT = old file (deletions), RIGHT = new file (additions)
  const hunkStart = side === "LEFT" ? hunkOldStart : hunkNewStart;
  const commentStart = startLine ?? endLine ?? hunkStart;
  const commentEnd = endLine ?? commentStart;

  // walk through diff lines, tracking line numbers for both old and new files
  // - lines: old file only (LEFT)
  // + lines: new file only (RIGHT)
  // context lines: both files
  type DiffLine = { text: string; lineNum: number | null };
  const diffLines: DiffLine[] = [];
  let oldLineNum = hunkOldStart;
  let newLineNum = hunkNewStart;

  for (const line of contentLines) {
    const prefix = line[0];
    if (prefix === "-") {
      // deletion - only has old line number
      diffLines.push({ text: line, lineNum: side === "LEFT" ? oldLineNum : null });
      oldLineNum++;
    } else if (prefix === "+") {
      // addition - only has new line number
      diffLines.push({ text: line, lineNum: side === "RIGHT" ? newLineNum : null });
      newLineNum++;
    } else {
      // context - has both line numbers
      diffLines.push({ text: line, lineNum: side === "LEFT" ? oldLineNum : newLineNum });
      oldLineNum++;
      newLineNum++;
    }
  }

  // find lines for comment range with context
  const targetStart = commentStart - CONTEXT_PADDING;
  const targetEnd = commentEnd;

  const result: string[] = [];
  let truncatedBefore = 0;

  for (let i = 0; i < diffLines.length; i++) {
    const dl = diffLines[i];
    // include if: within target range, OR it's an "other side" line adjacent to included lines
    const inRange = dl.lineNum !== null && dl.lineNum >= targetStart && dl.lineNum <= targetEnd;
    // include opposite-side lines if they're between included lines
    const adjacentOtherSide = dl.lineNum === null && result.length > 0 && i < diffLines.length - 1;

    if (inRange || adjacentOtherSide) {
      result.push(dl.text);
    } else if (result.length === 0) {
      truncatedBefore++;
    }
  }

  if (truncatedBefore > 0) {
    return `${header}\n... (${truncatedBefore} lines above) ...\n${result.join("\n")}`;
  }
  return `${header}\n${result.join("\n")}`;
}

// parsed hunk from a unified diff
export type ParsedHunk = {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  content: string[];
};

// parse a full file patch into individual hunks
export function parseFilePatches(patch: string): ParsedHunk[] {
  const hunks: ParsedHunk[] = [];
  const lines = patch.split("\n");

  let currentHunk: ParsedHunk | null = null;

  for (const line of lines) {
    const hunkMatch = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      if (currentHunk) hunks.push(currentHunk);
      currentHunk = {
        header: line,
        oldStart: parseInt(hunkMatch[1], 10),
        oldCount: parseInt(hunkMatch[2] ?? "1", 10),
        newStart: parseInt(hunkMatch[3], 10),
        newCount: parseInt(hunkMatch[4] ?? "1", 10),
        content: [],
      };
    } else if (currentHunk) {
      currentHunk.content.push(line);
    }
  }
  if (currentHunk) hunks.push(currentHunk);

  return hunks;
}

// find hunks that overlap with a line range (for LEFT or RIGHT side)
function findOverlappingHunks(
  hunks: ParsedHunk[],
  startLine: number,
  endLine: number,
  side: "LEFT" | "RIGHT"
): ParsedHunk[] {
  return hunks.filter((hunk) => {
    const hunkStart = side === "LEFT" ? hunk.oldStart : hunk.newStart;
    const hunkCount = side === "LEFT" ? hunk.oldCount : hunk.newCount;
    const hunkEnd = hunkStart + hunkCount - 1;

    // check for overlap: ranges overlap if start1 <= end2 && start2 <= end1
    return startLine <= hunkEnd && hunkStart <= endLine;
  });
}

// extract diff content from multiple hunks for a comment range
function extractFromFilePatches(
  hunks: ParsedHunk[],
  startLine: number,
  endLine: number,
  side: "LEFT" | "RIGHT"
): string {
  const overlapping = findOverlappingHunks(hunks, startLine, endLine, side);

  if (overlapping.length === 0) {
    return `(no diff hunks found for lines ${startLine}-${endLine})`;
  }

  if (overlapping.length === 1) {
    // single hunk - use existing extraction logic
    const hunk = overlapping[0];
    const fullHunk = hunk.header + "\n" + hunk.content.join("\n");
    return extractCommentedLines(fullHunk, startLine, endLine, side);
  }

  // multiple hunks - combine them with gap indicators
  const result: string[] = [];
  let prevHunkEnd = 0;

  for (let i = 0; i < overlapping.length; i++) {
    const hunk = overlapping[i];
    const hunkStart = side === "LEFT" ? hunk.oldStart : hunk.newStart;
    const hunkCount = side === "LEFT" ? hunk.oldCount : hunk.newCount;
    const hunkEnd = hunkStart + hunkCount - 1;

    // add gap indicator if there's a gap between hunks
    if (i > 0 && hunkStart > prevHunkEnd + 1) {
      const gapSize = hunkStart - prevHunkEnd - 1;
      result.push(`\n... (${gapSize} unchanged lines) ...\n`);
    }

    // add the hunk header and content
    result.push(hunk.header);
    result.push(...hunk.content);

    prevHunkEnd = hunkEnd;
  }

  return result.join("\n");
}

export const GetReviewComments = type({
  pull_number: type.number.describe("The pull request number"),
  review_id: type.number.describe("The review ID to get comments for"),
});

function hasThumbsUpFrom(comment: ReviewThreadComment, username: string): boolean {
  if (!comment.reactionGroups) return false;
  const thumbsUp = comment.reactionGroups.find((g) => g.content === "THUMBS_UP");
  if (!thumbsUp?.reactors?.nodes) return false;
  const needle = username.toLowerCase();
  return thumbsUp.reactors.nodes.some((r) => r?.login?.toLowerCase() === needle);
}

function threadHasThumbsUpFrom(thread: ReviewThread, username: string): boolean {
  const comments = thread.comments?.nodes ?? [];
  return comments.some((c) => c && hasThumbsUpFrom(c, username));
}

/**
 * formats thread blocks into markdown with TOC and line numbers.
 * extracted for testability.
 */
export function formatReviewThreads(
  threadBlocks: Array<{ path: string; lineRange: string; content: string[] }>,
  header: { pullNumber: number; reviewId: number; reviewer: string; reviewBody?: string }
) {
  // header section takes: title (1) + blank (1) + "## TOC" (1) + blank (1) + N TOC entries + blank (1) + "---" (1) + blank (1)
  const tocHeaderLines = 4;
  const tocFooterLines = 3;
  let currentLine = tocHeaderLines + threadBlocks.length + tocFooterLines + 1;

  // account for review body section if present
  const reviewBodyLines: string[] = [];
  if (header.reviewBody) {
    reviewBodyLines.push("## Review Body", "", header.reviewBody, "");
    currentLine += reviewBodyLines.reduce((sum, line) => sum + countLines(line), 0);
  }

  const tocEntries: string[] = [];
  const threadLines: string[] = [];

  for (const block of threadBlocks) {
    const startLine = currentLine;
    const actualLineCount = block.content.reduce((sum, line) => sum + countLines(line), 0);
    const endLine = currentLine + actualLineCount - 1;
    tocEntries.push(`- ${block.path}:${block.lineRange} → lines ${startLine}-${endLine}`);
    threadLines.push(...block.content);
    currentLine += actualLineCount;
  }

  const lines: string[] = [];
  lines.push(
    `# Review Threads (${threadBlocks.length}) for PR #${header.pullNumber} - Review ${header.reviewId} by ${header.reviewer}`
  );
  lines.push("");
  if (threadBlocks.length > 0) {
    lines.push("## TOC");
    lines.push("");
    lines.push(...tocEntries);
    lines.push("");
  }
  lines.push(...reviewBodyLines);
  lines.push("---");
  lines.push("");
  lines.push(...threadLines);

  return {
    toc: tocEntries.join("\n"),
    content: lines.join("\n"),
  };
}

/**
 * builds thread blocks from review threads and file patches.
 * extracted for testability.
 */
export function buildThreadBlocks(
  threads: ReviewThread[],
  filePatchMap: Map<string, ParsedHunk[]>,
  reviewId: number
) {
  // sort threads by file path, then by line number
  threads.sort((a, b) => {
    const pathCmp = a.path.localeCompare(b.path);
    if (pathCmp !== 0) return pathCmp;
    const aLine = a.startLine ?? a.line ?? 0;
    const bLine = b.startLine ?? b.line ?? 0;
    return aLine - bLine;
  });

  const threadBlocks: Array<{ path: string; lineRange: string; content: string[] }> = [];

  for (const thread of threads) {
    const allComments = (thread.comments?.nodes ?? []).filter(
      (c): c is ReviewThreadComment => c !== null
    );
    if (allComments.length === 0) continue;

    // get line info from thread, or fall back to first comment's line info
    const firstComment = allComments[0];
    const line =
      thread.line ?? firstComment?.line ?? firstComment?.originalLine ?? thread.startLine ?? 0;
    const startLine =
      thread.startLine ?? firstComment?.startLine ?? firstComment?.originalStartLine ?? line;
    const lineRange = startLine === line ? `${line}` : `${startLine}-${line}`;
    const block: string[] = [];

    // header with file:line range and status
    const status = thread.isResolved ? " [RESOLVED]" : thread.isOutdated ? " [OUTDATED]" : "";
    block.push(`## ${thread.path}:${lineRange}${status}`);
    block.push("");

    // show all comments in the thread (full conversation history)
    for (const comment of allComments) {
      const author = comment.author?.login ?? "unknown";
      const isTargetReview = comment.pullRequestReview?.databaseId === reviewId;
      const marker = isTargetReview ? " *" : "";

      block.push(
        `\`\`\`\`comment author=${author} id=${comment.fullDatabaseId ?? "unknown"} review=${comment.pullRequestReview?.databaseId ?? "unknown"} thread=${thread.id}${marker}`
      );
      block.push(comment.body || "(no comment body)");
      block.push("````");
      block.push("");
    }

    // diff context
    const fileHunks = filePatchMap.get(thread.path);
    const firstCommentWithHunk = allComments.find((c) => c.diffHunk);
    let diffContent: string | null = null;

    if (fileHunks && fileHunks.length > 0) {
      const overlapping = findOverlappingHunks(fileHunks, startLine, line, thread.diffSide);
      if (overlapping.length > 0) {
        diffContent = extractFromFilePatches(fileHunks, startLine, line, thread.diffSide);
      }
    }

    if (!diffContent && firstCommentWithHunk) {
      diffContent = extractCommentedLines(
        firstCommentWithHunk.diffHunk,
        startLine,
        line,
        thread.diffSide
      );
    }

    if (diffContent) {
      block.push(`\`\`\`diff file=${thread.path} lines=${lineRange} side=${thread.diffSide}`);
      block.push(diffContent);
      block.push("```");
      block.push("");
    } else {
      block.push(`\`\`\`diff file=${thread.path} lines=${lineRange} side=${thread.diffSide}`);
      block.push(`(no diff context available - comment on unchanged lines)`);
      block.push("```");
      block.push("");
    }

    threadBlocks.push({ path: thread.path, lineRange, content: block });
  }

  return threadBlocks;
}

/**
 * The thread graph and the file list are PR-scoped: `REVIEW_THREADS_QUERY` pulls
 * EVERY thread on the PR and the review filter is applied client-side below, so
 * the responses are byte-identical for every `reviewId` on the same PR.
 * `get_review_comments` was refetching both on every call - 28 identical
 * round trips per run across 84 runs, contributing to installation-wide API
 * limit exhaustion. See #1097.
 *
 * The 60s TTL is chosen, not incidental: it covers the burst without outliving
 * a resolve loop, since `isResolved` / `isOutdated` drive the `[RESOLVED]` /
 * `[OUTDATED]` markers and `resolve_review_thread` mutates that state mid-run.
 * `resolveReviewThreadCache` invalidates explicitly on top of that.
 *
 * Two-arg form on purpose: `yes.op` excludes the second parameter from the
 * cache key, so the octokit client is never hashed into it.
 */
const fetchAllReviewThreads = yes.op(
  async (key: { owner: string; name: string; pullNumber: number }, ctx: { octokit: Octokit }) => {
    const response = await ctx.octokit.graphql<ReviewThreadsQueryResponse>(REVIEW_THREADS_QUERY, {
      owner: key.owner,
      name: key.name,
      prNumber: key.pullNumber,
    });
    return response.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  },
  { ttl: 60_000, name: "reviewThreads" }
);

const fetchPrFiles = yes.op(
  async (key: { owner: string; name: string; pullNumber: number }, ctx: { octokit: Octokit }) =>
    ctx.octokit.paginate(ctx.octokit.rest.pulls.listFiles, {
      owner: key.owner,
      repo: key.name,
      pull_number: key.pullNumber,
      per_page: 100,
    }),
  { ttl: 60_000, name: "prFiles" }
);

/**
 * Drop the cached thread graph after a mutation that changes resolved state,
 * so the agent can never be shown its own just-resolved thread as unresolved.
 * Repo-wide rather than per-PR because `resolve_review_thread` takes only a
 * GraphQL node ID - and a run targets one PR anyway, so the wider sweep costs
 * nothing and cannot miss.
 */
function invalidateReviewThreadCache(repo: { owner: string; name: string }): void {
  fetchAllReviewThreads.invalidate(
    (cached) => cached.owner === repo.owner && cached.name === repo.name
  );
}

async function getReviewThreads(input: GetReviewDataInput) {
  // CLONE before returning: the caller rewrites `comment.body` in place while
  // resolving inline assets, and handing back the cached objects would make the
  // next call re-resolve its own output - re-downloading every asset, since the
  // rewritten body still matches `hasImages` and `bodyHTML` is still the
  // original. cloning here keeps the cached copy pristine.
  const allThreads = structuredClone(
    await fetchAllReviewThreads(
      { owner: input.owner, name: input.name, pullNumber: input.pullNumber },
      { octokit: input.octokit }
    )
  );

  if (allThreads.length >= 100) {
    log.warning(
      `PR ${input.owner}/${input.name}#${input.pullNumber}: reviewThreads returned 100 results (limit reached, some threads may be missing)`
    );
  }
  for (const thread of allThreads) {
    if (thread?.comments?.nodes && thread.comments.nodes.length >= 50) {
      log.warning(
        `PR ${input.owner}/${input.name}#${input.pullNumber}: review thread at ${thread.path}:${thread.line} has 50 comments (limit reached, some comments may be missing)`
      );
    }
  }

  const threadsForReview = allThreads.filter((thread): thread is ReviewThread => {
    if (!thread?.comments?.nodes) return false;
    return thread.comments.nodes.some((c) => c?.pullRequestReview?.databaseId === input.reviewId);
  });

  if (!input.approvedBy) {
    return threadsForReview;
  }

  const username = input.approvedBy;
  return threadsForReview.filter((thread) => threadHasThumbsUpFrom(thread, username));
}

interface GetReviewDataInput {
  octokit: Octokit;
  owner: string;
  name: string;
  pullNumber: number;
  reviewId: number;
  approvedBy?: string | undefined;
  tmpdir: string;
  githubToken: string;
}

// pure formatter: takes already-fetched GitHub responses and produces the
// review data the MCP tool returns. extracted from getReviewData so tests
// can drive it from checked-in fixtures without live API access.
//
// `prFiles` may be empty when `threads` is empty - callers that hit the
// network should skip the listFiles call in that case as a perf
// optimization. when both are empty and `review.body` is also empty, the
// formatter returns undefined just like getReviewData.
export interface FormatReviewDataInput {
  review: ReviewResponse;
  threads: ReviewThread[];
  prFiles: ReviewPrFile[];
  pullNumber: number;
  reviewId: number;
}

export type ReviewResponse = {
  body: string | null | undefined;
  user: { login: string } | null | undefined;
};

export type ReviewPrFile = {
  filename: string;
  patch?: string | undefined;
};

export function formatReviewData(input: FormatReviewDataInput):
  | {
      threadBlocks: Array<{ path: string; lineRange: string; content: string[] }>;
      reviewer: string;
      formatted: { toc: string; content: string };
    }
  | undefined {
  const rawReviewBody = input.review.body;
  const reviewBody = rawReviewBody ? stripExistingFooter(rawReviewBody) : "";
  const reviewer = input.review.user?.login ?? "unknown";

  if (input.threads.length === 0 && !reviewBody) return undefined;

  let threadBlocks: Array<{ path: string; lineRange: string; content: string[] }> = [];

  if (input.threads.length > 0) {
    const filePatchMap = new Map<string, ParsedHunk[]>();
    for (const file of input.prFiles) {
      if (file.patch) {
        filePatchMap.set(file.filename, parseFilePatches(file.patch));
      }
    }
    threadBlocks = buildThreadBlocks(input.threads, filePatchMap, input.reviewId);
  }

  const formatted = formatReviewThreads(threadBlocks, {
    pullNumber: input.pullNumber,
    reviewId: input.reviewId,
    reviewer,
    reviewBody,
  });

  return { threadBlocks, reviewer, formatted };
}

export async function getReviewData(input: GetReviewDataInput): Promise<
  | {
      threadBlocks: Array<{ path: string; lineRange: string; content: string[] }>;
      reviewer: string;
      formatted: { toc: string; content: string };
    }
  | undefined
> {
  const [review, threads] = await Promise.all([
    input.octokit.rest.pulls.getReview({
      owner: input.owner,
      repo: input.name,
      pull_number: input.pullNumber,
      review_id: input.reviewId,
      headers: { accept: "application/vnd.github.full+json" },
    }),
    getReviewThreads(input),
  ]);

  // skip listFiles when there are no threads - prFiles is only used for
  // building thread blocks, and an empty array short-circuits below.
  const prFiles =
    threads.length > 0
      ? await fetchPrFiles(
          { owner: input.owner, name: input.name, pullNumber: input.pullNumber },
          { octokit: input.octokit }
        )
      : [];

  if (review.data.body) {
    review.data.body =
      (await resolveBodyAssets({
        body: review.data.body,
        bodyHtml: review.data.body_html,
        tmpdir: input.tmpdir,
        githubToken: input.githubToken,
      })) ?? review.data.body;
  }

  for (const thread of threads) {
    for (const comment of thread.comments?.nodes ?? []) {
      if (comment?.body) {
        comment.body =
          (await resolveBodyAssets({
            body: comment.body,
            bodyHtml: comment.bodyHTML,
            tmpdir: input.tmpdir,
            githubToken: input.githubToken,
          })) ?? comment.body;
      }
    }
  }

  return formatReviewData({
    review: review.data,
    threads,
    prFiles,
    pullNumber: input.pullNumber,
    reviewId: input.reviewId,
  });
}

export function GetReviewCommentsTool(ctx: ToolContext) {
  return tool({
    name: "get_review_comments",
    description:
      "Get review comments for a pull request review with full thread context. " +
      "Example: `get_review_comments({ pull_number: 1234, review_id: 567890 })`. " +
      "Automatically filters to approved comments when applicable. " +
      "Returns a TOC and commentsPath pointing to a markdown file with full comment details.",
    parameters: GetReviewComments,
    execute: execute(async (params) => {
      // auto-filter to approved comments when the event has approved_only set
      const approvedBy =
        ctx.payload.event.trigger === "fix_review" && ctx.payload.event.approved_only
          ? ctx.payload.triggerer
          : undefined;

      const result = await getReviewData({
        octokit: ctx.octokit,
        owner: ctx.repo.owner,
        name: ctx.repo.name,
        pullNumber: params.pull_number,
        reviewId: params.review_id,
        approvedBy,
        tmpdir: ctx.tmpdir,
        githubToken: ctx.githubInstallationToken,
      });

      if (!result) {
        return {
          review_id: params.review_id,
          pull_number: params.pull_number,
          reviewer: "unknown",
          threadCount: 0,
          commentsPath: null,
          toc: null,
          instructions: approvedBy
            ? `no threads with 👍 from ${approvedBy}`
            : "no threads found for this review",
        };
      }

      const { threadBlocks, reviewer, formatted } = result;

      const tempDir = process.env.POLARIS_TEMP_DIR;
      if (!tempDir) {
        throw new Error("POLARIS_TEMP_DIR not set");
      }
      const filename = `review-${params.review_id}-threads.md`;
      const commentsPath = join(tempDir, filename);
      writeFileSync(commentsPath, formatted.content);
      log.debug(`wrote ${threadBlocks.length} threads to ${commentsPath}`);

      return {
        review_id: params.review_id,
        pull_number: params.pull_number,
        reviewer,
        threadCount: threadBlocks.length,
        commentsPath,
        toc: formatted.toc,
        instructions:
          `the file at commentsPath contains ${threadBlocks.length} review threads with full conversation history. ` +
          `comments marked with * are from the target review (${params.review_id}). ` +
          `the TOC shows each thread's file:line and the line number where it appears in the file. ` +
          `to read a specific thread, use: grep -A 50 "^## <file:line>" ${commentsPath} ` +
          `(replace <file:line> with the path from the TOC, e.g. "^## action/utils/foo.ts:42"). ` +
          `address each thread in order, working through one file at a time.`,
      };
    }),
  });
}

export const ListPullRequestReviews = type({
  pull_number: type.number.describe("The pull request number to list reviews for"),
});

export function ListPullRequestReviewsTool(ctx: ToolContext) {
  return tool({
    name: "list_pull_request_reviews",
    description:
      "List all reviews for a pull request. Returns all reviews including approvals, request changes, and comments. " +
      "Example: `list_pull_request_reviews({ pull_number: 1234 })`.",
    parameters: ListPullRequestReviews,
    execute: execute(async (params) => {
      const reviews = await ctx.octokit.paginate(ctx.octokit.rest.pulls.listReviews, {
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        pull_number: params.pull_number,
        headers: { accept: "application/vnd.github.full+json" },
      });

      const processedReviews = await Promise.all(
        reviews.map(async (review) => ({
          id: review.id,
          node_id: review.node_id,
          body: await resolveBodyAssets({
            body: review.body,
            bodyHtml: review.body_html,
            tmpdir: ctx.tmpdir,
            githubToken: ctx.githubInstallationToken,
          }),
          state: review.state,
          user: review.user?.login,
          submitted_at: review.submitted_at,
          commit_id: review.commit_id,
          html_url: review.html_url,
        }))
      );

      return {
        pull_number: params.pull_number,
        reviews: processedReviews,
        count: processedReviews.length,
      };
    }),
  });
}

const RESOLVE_REVIEW_THREAD_MUTATION = `
mutation($threadId: ID!) {
  resolveReviewThread(input: {threadId: $threadId}) {
    thread {
      id
      isResolved
    }
  }
}
`;

export const ResolveReviewThread = type({
  thread_id: type.string.describe("The GraphQL node ID of the review thread to resolve"),
});

export function ResolveReviewThreadTool(ctx: ToolContext) {
  return tool({
    name: "resolve_review_thread",
    mutates: true,
    description:
      "Mark a review thread as resolved using GitHub's GraphQL API. " +
      "Only call this after addressing the review feedback, implementing fixes, testing them, and posting a reply. " +
      "Do not resolve threads that are already resolved, threads where no action was taken, or threads where you disagree with the feedback.",
    parameters: ResolveReviewThread,
    execute: execute(async (params) => {
      try {
        const response = await ctx.octokit.graphql<{
          resolveReviewThread: {
            thread: {
              id: string;
              isResolved: boolean;
            };
          };
        }>(RESOLVE_REVIEW_THREAD_MUTATION, {
          threadId: params.thread_id,
        });

        const thread = response.resolveReviewThread.thread;
        log.info(`» resolved review thread ${thread.id}`);
        invalidateReviewThreadCache({ owner: ctx.repo.owner, name: ctx.repo.name });

        return {
          thread_id: thread.id,
          is_resolved: thread.isResolved,
          success: true,
          message: "Thread resolved successfully",
        };
      } catch (error) {
        // handle common error cases gracefully
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isResolved =
          errorMessage.includes("already resolved") || errorMessage.includes("isResolved");

        const message = isResolved
          ? `thread ${params.thread_id} was already resolved`
          : `failed to resolve thread ${params.thread_id}: ${errorMessage}`;
        log.info(message);

        return {
          thread_id: params.thread_id,
          is_resolved: isResolved,
          success: isResolved,
          message,
        };
      }
    }),
  });
}
