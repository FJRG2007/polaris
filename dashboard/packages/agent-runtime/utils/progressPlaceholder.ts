import { stripExistingFooter } from "./buildPolarisFooter.ts";

/**
 * The prefix text for the initial "working on it" comment.
 * Used to detect whether a progress comment is still in its initial state
 * and hasn't been updated with real progress or error messages.
 *
 * Lives in `utils/` (not `mcp/`) so it can be re-exported via `polaris/internal`
 * without dragging the MCP server's transitive imports into the Next.js app's
 * type-check graph.
 */
export const PROGRESS_PLACEHOLDER_PREFIX = "Working on it";

export function isProgressPlaceholderBody(body: string): boolean {
  const content = stripExistingFooter(body).trimStart();
  const firstLine = content.split(/\r?\n/, 1)[0]?.trimEnd() ?? "";
  return new RegExp(`(^|\\s)${PROGRESS_PLACEHOLDER_PREFIX}(\\.\\.\\.)?$`).test(firstLine);
}
