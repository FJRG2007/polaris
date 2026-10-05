import { describe, expect, it } from "vitest";
import { CLAUDE_EXEC_TOOL_DENY_RULES } from "./claude.ts";

describe("CLAUDE_EXEC_TOOL_DENY_RULES", () => {
    // Every native tool of the pinned claude-code that runs a command or code has to
    // be denied, at top level and inside a subagent, or it runs with the agent's
    // full environment and around the filtered MCP shell.
    it.each(["Bash", "PowerShell", "Monitor", "REPL", "Workflow"])(
        "denies %s directly and in subagents",
        (tool) => {
            expect(CLAUDE_EXEC_TOOL_DENY_RULES).toContain(tool);
            expect(CLAUDE_EXEC_TOOL_DENY_RULES).toContain(`Agent(${tool})`);
        }
    );
});
