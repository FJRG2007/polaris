import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import type { AgentView } from "@/lib/polar/agents/shared";
import { subagentTypes } from "@/lib/polar/subagents/types";
import { withOpencodePermission } from "@/lib/agents/session-runtime";
import { REPO_AGENTS, REPO_AGENTS_PROGRAM } from "@/lib/agents/session-commands";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { claudeAgentFile, sessionAgentFiles, SESSION_AGENT_FILES_BYTES } from "@/lib/polar/agents/repo-agents";

const REVIEW = [
    "---",
    "description: Reviews code",
    "mode: subagent",
    "permission:",
    "  edit: deny",
    "---",
    "Review the change."
].join("\n");

describe("repository agents in a session", () => {
    it("writes OpenCode's file as is and a Claude Code subagent beside it", () => {
        const files = sessionAgentFiles([{ path: ".polaris/agents/Code Review.md", content: REVIEW }]);
        expect(Object.keys(files)).toEqual([".opencode/agent/code-review.md", ".claude/agents/code-review.md"]);
        expect(files[".opencode/agent/code-review.md"]).toBe(REVIEW);
        expect(files[".claude/agents/code-review.md"]).toContain('name: "code-review"');
        expect(files[".claude/agents/code-review.md"]).toContain('description: "Reviews code"');
    });

    it("keeps a primary-only agent out of Claude Code's subagents and skips what does not read", () => {
        const primary = "---\nmode: primary\n---\nPlan.";
        const files = sessionAgentFiles([
            { path: ".polaris/agents/plan.md", content: primary },
            { path: ".polaris/agents/broken.md", content: "---\nmode: [\n---\nx" }
        ]);
        expect(Object.keys(files)).toEqual([".opencode/agent/plan.md"]);
    });

    it("stays within the boot environment's budget", () => {
        const big = `---\ndescription: d\n---\n${"x".repeat(19_000)}`;
        const many = Array.from({ length: 20 }, (_, index) => ({ path: `.polaris/agents/a${index}.md`, content: big }));
        const files = sessionAgentFiles(many);
        expect(JSON.stringify(files).length).toBeLessThanOrEqual(SESSION_AGENT_FILES_BYTES);
        expect(Object.keys(files).length).toBeGreaterThan(0);
    });

    it("quotes a description that would break the frontmatter", () => {
        const file = claudeAgentFile({
            name: "x",
            description: 'Says "hi": twice\nand more',
            instructions: "Do it.",
            mode: "all",
            model: null,
            steps: null,
            permission: []
        });
        expect(file).toContain('description: "Says \\"hi\\": twice and more"');
    });

    it("the boot program adds only missing files, under the agents folders, and excludes them from git", () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), "repo-agents-"));
        try {
            mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
            mkdirSync(path.join(dir, ".claude", "agents"), { recursive: true });
            writeFileSync(path.join(dir, ".claude", "agents", "kept.md"), "theirs");
            const input = path.join(dir, "files.json");
            writeFileSync(
                input,
                JSON.stringify({
                    ".claude/agents/kept.md": "ours",
                    ".opencode/agent/new.md": "new",
                    "../escape.md": "no",
                    ".git/hooks/pre-commit.md": "no"
                })
            );
            const program = path.join(dir, "program.js");
            writeFileSync(program, REPO_AGENTS_PROGRAM);
            execFileSync(process.execPath, [program, input], { cwd: dir });
            expect(readFileSync(path.join(dir, ".claude", "agents", "kept.md"), "utf8")).toBe("theirs");
            expect(readFileSync(path.join(dir, ".opencode", "agent", "new.md"), "utf8")).toBe("new");
            expect(readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8")).toBe("\n/.opencode/agent/new.md\n");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
        expect(REPO_AGENTS.join("\n")).toContain('as_agent "node');
    });
});

describe("agent rules in an OpenCode session", () => {
    it("adds the rules to the config OpenCode already gets", () => {
        const env = withOpencodePermission(
            "opencode",
            { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "m" }) },
            [
                { action: "shell", resource: "*", effect: "ask" },
                { action: "shell", resource: "git status *", effect: "allow" }
            ]
        );
        expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({
            model: "m",
            permission: { shell: { "*": "ask", "git status *": "allow" } }
        });
    });

    it("leaves another tool, and an agent with no rules, alone", () => {
        const env = { OPENCODE_CONFIG_CONTENT: "{}" };
        expect(withOpencodePermission("claude", env, [{ action: "*", resource: "*", effect: "deny" }])).toBe(env);
        expect(withOpencodePermission("opencode", env, [])).toBe(env);
    });
});

describe("agent mode in subagent picking", () => {
    const agent = (name: string, mode: AgentView["mode"]): AgentView => ({
        id: name,
        name,
        description: `${name} agent`,
        instructions: "x",
        skills: [],
        connectorIds: [],
        web: true,
        choice: null,
        engine: "polar",
        account: null,
        models: [],
        modelPolicy: "preferred",
        permission: [],
        mode,
        shared: false,
        mine: true
    });

    it("offers subagent and all agents, never a primary-only one", () => {
        const names = subagentTypes([agent("p", "primary"), agent("s", "subagent"), agent("a", "all")]).map(
            (type) => type.name
        );
        expect(names).toContain("s");
        expect(names).toContain("a");
        expect(names).not.toContain("p");
    });
});
