import { type } from "arktype";
import { apiFetch } from "../utils/apiFetch.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

export const SimilarIssues = type({
  issue_number: type.number.describe("The issue number to find older duplicate candidates for"),
});

export function SimilarIssuesTool(ctx: ToolContext) {
  return tool({
    name: "find_similar_issues",
    description:
      "Find high-recall older duplicate candidates for an issue. Similarity is only retrieval: inspect promising candidates with get_issue before deciding whether they are duplicates.",
    mutates: true,
    parameters: SimilarIssues,
    execute: execute(async (input) => {
      if (ctx.payload.event.is_pr || ctx.payload.event.issue_number !== input.issue_number) {
        throw new Error("find_similar_issues is limited to the issue that triggered this run");
      }
      const response = await apiFetch({
        path: `/api/repo/${ctx.repo.owner}/${ctx.repo.name}/issues/${input.issue_number}/similar`,
        headers: {
          authorization: `Bearer ${ctx.apiToken}`,
        },
        signal: AbortSignal.timeout(13 * 60_000),
      });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(`similar issue lookup returned ${response.status}: ${message}`);
      }
      return { result: await response.json() };
    }),
  });
}
