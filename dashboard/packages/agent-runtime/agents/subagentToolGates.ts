/**
 * Single source of truth for which MCP tools subagents are forbidden from
 * calling - derived from each tool's `mutates` flag, not a hand-maintained list.
 *
 * Subagents share the orchestrator's in-process git working tree, `toolState`,
 * progress comment, and run-scoped pr/branch context. A subagent that calls
 * `checkout_pr` switches the orchestrator's HEAD; one that calls `push_branch`
 * pushes whatever the orchestrator happens to have committed. The 2026-05-18
 * `zed-industries/cloud` incident hit exactly this: a `reviewer` lens
 * dispatched `checkout_pr({2582})` mid-review, the orchestrator's next push
 * clobbered an unrelated engineer's branch. PR #796 added runtime backstops
 * inside `checkout_pr`/`push_branch`; this gate stops the call from ever
 * reaching MCP when it originates from a subagent.
 *
 * The denied set is whatever the run actually registers with `mutates: true`
 * (see `action/mcp/shared.ts`). To deny a new state-changing MCP tool to
 * subagents, mark it `mutates: true` at its definition - nothing to add here.
 * Read-only tools (`get_*`, `list_*`, `git_fetch`, …) and the general-purpose
 * `git`/`shell` execution tools are intentionally unmarked: denying them would
 * make review impossible, and their mutations are gated by command-arg
 * validation plus the reviewer system prompt (`action/agents/reviewer.ts`).
 *
 * The gate is enforced at two pre-tool hooks, each fed this derived list:
 *   - opencode: `tool.execute.before` (action/agents/opencodePlugin.ts)
 *   - claude:   `PreToolUse` settings hook (action/agents/claudePretoolGate.ts)
 * Names are the canonical bare form (the FastMCP tool `name`). Each runtime
 * presents them with a different prefix (`mcp__polaris__<name>` for claude,
 * `polaris_<name>` for opencode); the hooks strip the prefix before comparing.
 */

import { buildOrchestratorTools, type ToolContext } from "../mcp/server.ts";

/**
 * Canonical bare names of every state-mutating MCP tool registered for this
 * run - the set subagents are denied. Derived from the `mutates` flag so it can
 * never silently drift from the registered tool set. Throws if it derives empty
 * (a sign the flag plumbing broke) rather than starting with the gate disabled.
 */
export function subagentDeniedToolNames(
  ctx: ToolContext,
  outputSchema?: Record<string, unknown>
): string[] {
  const names = buildOrchestratorTools(ctx, outputSchema)
    .filter((toolDef) => toolDef.mutates)
    .map((toolDef) => toolDef.name);
  if (names.length === 0) {
    throw new Error(
      "subagent deny list derived empty - no MCP tool is marked `mutates: true`. " +
        "refusing to start with the subagent gate effectively disabled."
    );
  }
  return names;
}
