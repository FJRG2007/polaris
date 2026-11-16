import { describe, expect, it } from "vitest";
import {
    claudeCallResource,
    claudePermissionSettings,
    configFromRules,
    evaluatePermission,
    rulesFromConfig,
    rulesOf,
    toolDisabled,
    wildcardMatch
} from "@/lib/polar/agents/permissions";
import { agentNameFromPath, parseAgentFile } from "@/lib/polar/agents/agent-files";
import { agentApproval, callResource, withAgentRules } from "@/lib/polar/agents/chat-permissions";

describe("wildcardMatch (OpenCode's Wildcard.match)", () => {
    it("matches runs, single characters and the bare command", () => {
        expect(wildcardMatch("git status", "git status *")).toBe(true);
        expect(wildcardMatch("git status --short", "git status *")).toBe(true);
        expect(wildcardMatch("git statusx", "git status *")).toBe(false);
        expect(wildcardMatch("src/a.ts", "src/*.ts")).toBe(true);
        expect(wildcardMatch("ab", "a?")).toBe(true);
        expect(wildcardMatch("a.b", "a?b")).toBe(true);
        expect(wildcardMatch("axb", "a.b")).toBe(false);
        expect(wildcardMatch("src\\a.ts", "src/*")).toBe(true);
        expect(wildcardMatch("", "*")).toBe(true);
    });
});

describe("rules from OpenCode's permission config", () => {
    it("reads one effect, per tool, and per pattern, in written order", () => {
        expect(rulesFromConfig("ask")).toEqual([{ action: "*", resource: "*", effect: "ask" }]);
        const rules = rulesFromConfig({ edit: "deny", bash: { "*": "ask", "git status *": "allow" } })!;
        expect(rules).toEqual([
            { action: "edit", resource: "*", effect: "deny" },
            { action: "shell", resource: "*", effect: "ask" },
            { action: "shell", resource: "git status *", effect: "allow" }
        ]);
        expect(evaluatePermission("shell", "git status", rules)).toBe("allow");
        expect(evaluatePermission("shell", "rm -rf /", rules)).toBe("ask");
        expect(evaluatePermission("edit", "a.ts", rules)).toBe("deny");
        // Nothing matches: ask, as OpenCode.
        expect(evaluatePermission("webfetch", "https://x", rules)).toBe("ask");
    });

    it("takes the last match", () => {
        const rules = rulesFromConfig({ bash: { "git *": "allow", "git push *": "deny" } })!;
        expect(evaluatePermission("shell", "git push origin", rules)).toBe("deny");
        expect(evaluatePermission("shell", "git log", rules)).toBe("allow");
    });

    it("reads the deprecated tools switches before permission, which wins", () => {
        const rules = rulesFromConfig({ edit: "ask" }, { write: false, bash: true })!;
        expect(rules).toEqual([
            { action: "edit", resource: "*", effect: "ask" },
            { action: "shell", resource: "*", effect: "allow" }
        ]);
    });

    it("refuses what does not read", () => {
        expect(rulesFromConfig({ websearch: { "*": "allow" } })).toBeNull();
        expect(rulesFromConfig({ edit: "maybe" })).toBeNull();
        expect(rulesOf([{ action: "edit", resource: "*", effect: "allow" }, { bad: 1 }])).toHaveLength(1);
    });

    it("says a tool denied whole is off, and writes rules back", () => {
        const rules = rulesFromConfig({ "*": "deny", read: "allow", edit: { "*.md": "allow" } })!;
        expect(toolDisabled("shell", rules)).toBe(true);
        expect(toolDisabled("read", rules)).toBe(false);
        expect(toolDisabled("edit", rules)).toBe(false);
        expect(configFromRules(rules)).toEqual({ "*": "deny", read: "allow", edit: { "*.md": "allow" } });
        expect(rulesFromConfig(configFromRules(rules))).toEqual(rules);
    });
});

describe("Claude Code mapping", () => {
    it("reads a call as an action and resource", () => {
        expect(claudeCallResource("Bash", { command: "ls" })).toEqual({ action: "shell", resource: "ls" });
        expect(claudeCallResource("Write", { file_path: "/a" })).toEqual({ action: "edit", resource: "/a" });
        expect(claudeCallResource("mcp__polaris__x", null)).toEqual({ action: "mcp__polaris__x", resource: "*" });
    });

    it("carries only rules nothing after them overrides", () => {
        const rules = rulesFromConfig({ bash: { "*": "ask", "git status *": "allow" }, webfetch: "deny" })!;
        // The "*" ask is overridden by the pattern after it; the pattern is last.
        expect(claudePermissionSettings(rules)).toEqual({
            allow: ["Bash(git status:*)"],
            ask: [],
            deny: ["WebFetch"]
        });
        expect(claudePermissionSettings(rulesFromConfig({ bash: { "npm test *": "allow" } })!)).toEqual({
            allow: ["Bash(npm test:*)"],
            ask: [],
            deny: []
        });
    });
});

describe("agent files", () => {
    it("reads an OpenCode agent", () => {
        const file = [
            "---",
            "description: Reviews code",
            "mode: subagent",
            "model: anthropic/claude-sonnet-4-5",
            "tools:",
            "  write: false",
            "permission:",
            "  bash:",
            '    "*": ask',
            '    "git diff *": allow',
            "---",
            "You review code.",
            ""
        ].join("\n");
        const agent = parseAgentFile(".opencode/agent/review.md", file);
        expect(agent).toMatchObject({
            name: "review",
            description: "Reviews code",
            instructions: "You review code.",
            mode: "subagent",
            model: "anthropic/claude-sonnet-4-5"
        });
        expect(typeof agent !== "string" && agent.permission).toEqual([
            { action: "edit", resource: "*", effect: "deny" },
            { action: "shell", resource: "*", effect: "ask" },
            { action: "shell", resource: "git diff *", effect: "allow" }
        ]);
    });

    it("reads a Claude Code subagent's tool list as allow those, deny the rest", () => {
        const file = "---\nname: explorer\ndescription: Looks\ntools: Read, Grep, Bash\nmodel: inherit\n---\nLook around.";
        const agent = parseAgentFile(".claude/agents/explorer.md", file);
        expect(agent).toMatchObject({ name: "explorer", mode: "subagent", model: null });
        const rules = typeof agent === "string" ? [] : agent.permission;
        expect(evaluatePermission("read", "a", rules)).toBe("allow");
        expect(evaluatePermission("edit", "a", rules)).toBe("deny");
    });

    it("skips what does not read", () => {
        expect(parseAgentFile(".polaris/agents/x.md", "---\nmode: boss\n---\nHi")).toBe("frontmatter");
        expect(parseAgentFile(".polaris/agents/x.md", "---\ndisable: true\n---\nHi")).toBe("empty");
        expect(parseAgentFile(".polaris/agents/x.md", "---\n")).toBe("markdown");
        expect(agentNameFromPath(".polaris/agents/team/lead.md")).toBe("team/lead");
    });
});

describe("rules in a chat turn", () => {
    const rules = rulesFromConfig({ web_fetch: { "*": "ask", "https://docs.*": "allow" }, tasks_delete: "deny" })!;
    const tools = {
        web_fetch: { execute: async () => ({ ok: true, text: "ran" }) },
        tasks_delete: { execute: async () => ({ ok: true, text: "ran" }) },
        tasks_list: { execute: async () => ({ ok: true, text: "ran" }) }
    };

    it("drops a tool denied whole and leaves the rest", () => {
        const offered = withAgentRules(tools as never, rules) as Record<string, unknown>;
        expect(Object.keys(offered)).toEqual(["web_fetch", "tasks_list"]);
        expect(withAgentRules(tools as never, [])).toBe(tools);
    });

    it("allows, asks, or keeps Polar's own rule", async () => {
        const approval = agentApproval({}, ["web_fetch", "tasks_list"], rules);
        expect(await approval.web_fetch!({ url: "https://docs.example" })).toBe("approved");
        expect(await approval.web_fetch!({ url: "https://other.example" })).toBe("user-approval");
        expect(await approval.tasks_list!({})).toBe("approved");
        expect(callResource({ command: "ls" })).toBe("ls");
    });

    it("refuses a denied call where it runs", async () => {
        const narrow = rulesFromConfig({ web_fetch: { "https://evil.*": "deny" } })!;
        const offered = withAgentRules(tools as never, narrow) as Record<string, { execute: (input: unknown, o: never) => Promise<unknown> }>;
        expect(await offered.web_fetch!.execute({ url: "https://evil.example" }, undefined as never)).toMatchObject({ ok: false });
        expect(await offered.web_fetch!.execute({ url: "https://fine.example" }, undefined as never)).toMatchObject({ ok: true });
    });
});
