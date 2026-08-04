import { type } from "arktype";
import { log } from "../utils/cli.ts";
import { fixDoubleEscapedString } from "../utils/fixDoubleEscapedString.ts";
import { patchWorkflowRunFields } from "../utils/patchWorkflowRunFields.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

export const Issue = type({
  title: type.string.describe("the title of the issue"),
  body: type.string.describe("the body content of the issue"),
  labels: type.string
    .array()
    .describe("optional array of label names to apply to the issue")
    .optional(),
  assignees: type.string
    .array()
    .describe("optional array of usernames to assign to the issue")
    .optional(),
});

export function IssueTool(ctx: ToolContext) {
  return tool({
    name: "create_issue",
    mutates: true,
    description: "Create a new GitHub issue",
    parameters: Issue,
    execute: execute(async (params) => {
      const result = await ctx.octokit.rest.issues.create({
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        title: params.title,
        body: fixDoubleEscapedString(params.body),
        labels: params.labels ?? [],
        assignees: params.assignees ?? [],
      });

      log.info(`» created issue #${result.data.number} (id ${result.data.id})`);

      const nodeId = result.data.node_id;
      if (typeof nodeId === "string" && nodeId.length > 0) {
        await patchWorkflowRunFields(ctx, {
          issueNodeId: nodeId,
        });
      }

      return {
        success: true,
        issueId: result.data.id,
        number: result.data.number,
        url: result.data.html_url,
        title: result.data.title,
        state: result.data.state,
        labels: result.data.labels?.map((label) =>
          typeof label === "string" ? label : label.name
        ),
        assignees: result.data.assignees?.map((assignee) => assignee.login),
      };
    }),
  });
}

export const CloseIssue = type({
  issue_number: type.number.describe("the issue number to close"),
  state_reason: type
    .enumerated("completed", "not_planned", "duplicate")
    .describe(
      "why the issue is being closed: 'completed' (resolved/done), 'not_planned' (won't fix, out of scope), or 'duplicate' (already tracked elsewhere)."
    ),
});

export function CloseIssueTool(ctx: ToolContext) {
  return tool({
    name: "close_issue",
    mutates: true,
    description:
      "Close a GitHub issue with a reason. " +
      'Example: `close_issue({ issue_number: 1234, state_reason: "not_planned" })`. ' +
      "Comment first to explain the decision - closing alone is opaque to the author.",
    parameters: CloseIssue,
    execute: execute(async (params) => {
      const result = await ctx.octokit.rest.issues.update({
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        issue_number: params.issue_number,
        state: "closed",
        state_reason: params.state_reason,
      });
      ctx.toolState.wasUpdated = true;
      log.info(`» closed issue #${params.issue_number} (${params.state_reason})`);

      return {
        success: true,
        number: result.data.number,
        url: result.data.html_url,
        state: result.data.state,
        stateReason: result.data.state_reason,
      };
    }),
  });
}

export const ReopenIssue = type({
  issue_number: type.number.describe("the issue number to reopen"),
});

export function ReopenIssueTool(ctx: ToolContext) {
  return tool({
    name: "reopen_issue",
    mutates: true,
    description:
      "Reopen a previously closed GitHub issue. " +
      "Example: `reopen_issue({ issue_number: 1234 })`.",
    parameters: ReopenIssue,
    execute: execute(async (params) => {
      const result = await ctx.octokit.rest.issues.update({
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        issue_number: params.issue_number,
        state: "open",
      });
      ctx.toolState.wasUpdated = true;
      log.info(`» reopened issue #${params.issue_number}`);

      return {
        success: true,
        number: result.data.number,
        url: result.data.html_url,
        state: result.data.state,
      };
    }),
  });
}
