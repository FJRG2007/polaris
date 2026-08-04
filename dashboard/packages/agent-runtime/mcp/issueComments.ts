import { type } from "arktype";
import { primaryRepoState } from "../toolState.ts";
import { resolveBodyAssets } from "../utils/body.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

export const GetIssueComments = type({
  issue_number: type.number.describe("The issue number to get comments for"),
});

export function GetIssueCommentsTool(ctx: ToolContext) {
  return tool({
    name: "get_issue_comments",
    description:
      "Get all comments for a GitHub issue. Returns all comments including the issue body and all subsequent discussion comments. " +
      "Example: `get_issue_comments({ issue_number: 1234 })`.",
    parameters: GetIssueComments,
    execute: execute(async ({ issue_number }) => {
      // set issue context
      primaryRepoState(ctx.toolState).issueNumber = issue_number;

      const comments = await ctx.octokit.paginate(ctx.octokit.rest.issues.listComments, {
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        issue_number,
        headers: { accept: "application/vnd.github.full+json" },
      });

      const processedComments = await Promise.all(
        comments.map(async (comment) => ({
          id: comment.id,
          body: await resolveBodyAssets({
            body: comment.body,
            bodyHtml: comment.body_html,
            tmpdir: ctx.tmpdir,
            githubToken: ctx.githubInstallationToken,
          }),
          user: comment.user?.login,
        }))
      );

      return {
        issue_number,
        comments: processedComments,
        count: processedComments.length,
      };
    }),
  });
}
