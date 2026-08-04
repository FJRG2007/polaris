import TurndownService from "turndown";
import type { PayloadEvent } from "../external.ts";
import { downloadAssetsInMarkdown } from "./assets.ts";
import type { OctokitWithPlugins } from "./github.ts";
import type { RunContextData } from "./runContextData.ts";

const turndown = new TurndownService();

function hasImages(body: string | null | undefined): boolean {
  if (!body) return false;
  return body.includes("<img") || body.includes("![");
}

interface ResolveBodyContext {
  event: PayloadEvent;
  octokit: OctokitWithPlugins;
  repo: RunContextData["repo"];
  tmpdir: string;
  githubToken: string;
}

/**
 * resolves the body of an event by fetching body_html and converting to markdown.
 * only fetches body_html if the body contains images (to avoid unnecessary API calls).
 * this ensures agents receive markdown with working signed image URLs instead of
 * broken user-attachments URLs.
 */
export async function resolveBody(ctx: ResolveBodyContext): Promise<string | null> {
  const body = ctx.event.body;
  const bodyHtml = hasImages(body) ? await fetchBodyHtml(ctx) : undefined;
  return resolveBodyAssets({
    body,
    bodyHtml,
    tmpdir: ctx.tmpdir,
    githubToken: ctx.githubToken,
  });
}

interface ResolveBodyAssetsContext {
  body: string | null | undefined;
  bodyHtml: string | null | undefined;
  tmpdir: string;
  githubToken: string;
}

/**
 * downloads github-hosted image assets in a body to disk and rewrites the urls to local
 * paths so the agent can read them. when the body has images and a rendered `bodyHtml`
 * is supplied, the html is turndowned first: github only exposes attachments as signed,
 * self-authenticating `*.githubusercontent.com` urls through body_html - the raw
 * `github.com/user-attachments/...` urls in unrendered markdown 404 for the installation
 * token. callers that fetch a body should request it with the `application/vnd.github.full+json`
 * media type and pass `body_html` here.
 */
export async function resolveBodyAssets(ctx: ResolveBodyAssetsContext): Promise<string | null> {
  let body = ctx.body ?? null;
  if (body && hasImages(body) && ctx.bodyHtml) {
    body = turndown.turndown(ctx.bodyHtml);
  }
  if (!body) return ctx.body ?? null;
  return downloadAssetsInMarkdown(body, ctx.tmpdir, ctx.githubToken);
}

async function fetchBodyHtml(ctx: ResolveBodyContext): Promise<string | undefined> {
  const event = ctx.event;
  const headers = { accept: "application/vnd.github.full+json" };
  const owner = ctx.repo.owner;
  const repo = ctx.repo.name;

  switch (event.trigger) {
    case "issue_comment_created":
      if (!event.comment_id) return;
      return (
        await ctx.octokit.rest.issues.getComment({
          owner,
          repo,
          comment_id: event.comment_id,
          headers,
        })
      ).data.body_html;

    case "issues_opened":
    case "issues_assigned":
    case "issues_labeled":
      if (!event.issue_number) return;
      return (
        await ctx.octokit.rest.issues.get({
          owner,
          repo,
          issue_number: event.issue_number,
          headers,
        })
      ).data.body_html;

    case "pull_request_opened":
    case "pull_request_ready_for_review":
    case "pull_request_synchronize":
    case "pull_request_review_requested":
      // PRs are also issues - use issues.get which returns body_html
      if (!event.issue_number) return;
      return (
        await ctx.octokit.rest.issues.get({
          owner,
          repo,
          issue_number: event.issue_number,
          headers,
        })
      ).data.body_html;

    case "pull_request_review_submitted":
      if (!event.issue_number || !event.review_id) return;
      return (
        await ctx.octokit.rest.pulls.getReview({
          owner,
          repo,
          pull_number: event.issue_number,
          review_id: event.review_id,
          headers,
        })
      ).data.body_html;

    case "pull_request_review_comment_created":
      if (!event.comment_id) return;
      return (
        await ctx.octokit.rest.pulls.getReviewComment({
          owner,
          repo,
          comment_id: event.comment_id,
          headers,
        })
      ).data.body_html;

    case "check_suite_completed":
      // body is the PR body
      if (!event.issue_number) return;
      return (
        await ctx.octokit.rest.issues.get({
          owner,
          repo,
          issue_number: event.issue_number,
          headers,
        })
      ).data.body_html;

    case "implement_plan":
      // body is the plan content from an issue comment
      if (!event.plan_comment_id) return;
      return (
        await ctx.octokit.rest.issues.getComment({
          owner,
          repo,
          comment_id: event.plan_comment_id,
          headers,
        })
      ).data.body_html;

    // triggers without a body field that needs resolution
    case "workflow_dispatch":
    case "fix_review":
    case "unknown":
      return undefined;

    default:
      // exhaustiveness check - TypeScript will error if a trigger is missing
      event satisfies never;
      return undefined;
  }
}
