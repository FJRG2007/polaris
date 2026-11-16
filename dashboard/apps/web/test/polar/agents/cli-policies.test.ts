import { describe, expect, it } from "vitest";
import { evaluatePermission, type PermissionRule } from "@/lib/polar/agents/permissions";
import {
    cliPolicyFile,
    cliPolicyGaps,
    codexPolicy,
    GEMINI_PRIORITY_BASE,
    geminiPolicy,
    shellPrefix,
    wildcardJsonRegex
} from "@/lib/polar/agents/cli-policies";

const rule = (action: string, resource: string, effect: PermissionRule["effect"]): PermissionRule => ({
    action,
    resource,
    effect
});

/** Gemini's engine as documented: the highest priority whose tool and
 *  pattern match decides; the pattern is tested on the sorted JSON args. */
function geminiDecide(contents: string, tool: string, args: Record<string, unknown>): string | null {
    const sorted = JSON.stringify(Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b))));
    const blocks = contents.split("[[rule]]").slice(1);
    let best: { priority: number; decision: string } | null = null;
    for (const block of blocks) {
        const field = (name: string) => {
            const line = block.split("\n").find((entry) => entry.startsWith(`${name} = `));
            return line ? JSON.parse(line.slice(name.length + 3)) : undefined;
        };
        const names = [field("toolName")].flat() as string[];
        if (!names.includes("*") && !names.includes(tool)) continue;
        const command = field("commandRegex") as string | undefined;
        const pattern = command !== undefined ? `"command":"${command}` : (field("argsPattern") as string | undefined);
        if (pattern !== undefined && !new RegExp(pattern).test(sorted)) continue;
        const priority = field("priority") as number;
        if (!best || priority > best.priority) best = { priority, decision: field("decision") as string };
    }
    return best?.decision ?? null;
}

/** Codex's engine as documented: exact leading argv words, most restrictive wins. */
function codexDecide(contents: string, command: string): string | null {
    const argv = command.split(/\s+/);
    const rank = ["allow", "prompt", "forbidden"];
    let best: string | null = null;
    for (const line of contents.split("\n").filter((entry) => entry.startsWith("prefix_rule("))) {
        const words = JSON.parse(line.match(/pattern = (\[[^\]]*\])/)![1]!) as string[];
        const decision = line.match(/decision = "(\w+)"/)![1]!;
        if (words.every((word, index) => argv[index] === word) && (!best || rank.indexOf(decision) > rank.indexOf(best))) {
            best = decision;
        }
    }
    return best;
}

const GEMINI_EFFECT = { allow: "allow", ask: "ask_user", deny: "deny" } as const;
const CODEX_EFFECT = { allow: "allow", ask: "prompt", deny: "forbidden" } as const;

describe("shell patterns as argv prefixes", () => {
    it("keeps a prefix and anything exact, and only the words before a wildcard", () => {
        expect(shellPrefix("git status *")).toEqual({ words: ["git", "status"], exact: true });
        expect(shellPrefix("git push")).toEqual({ words: ["git", "push"], exact: false });
        expect(shellPrefix("rm -rf *.tmp")).toEqual({ words: ["rm", "-rf"], exact: false });
        expect(shellPrefix("*")).toEqual({ words: [], exact: false });
        expect(shellPrefix("echo $HOME *")).toEqual({ words: ["echo"], exact: false });
    });
});

describe("Codex rules from an agent's rules", () => {
    it("writes allow, prompt and forbidden as prefix_rule lines", () => {
        const { file, gaps } = codexPolicy([
            rule("shell", "git *", "allow"),
            rule("shell", "git push *", "ask"),
            rule("shell", "rm *", "deny")
        ]);
        expect(file?.path).toBe(".codex/rules/polaris.rules");
        expect(file?.contents).toContain('prefix_rule(pattern = ["git"], decision = "allow")');
        expect(file?.contents).toContain('prefix_rule(pattern = ["git", "push"], decision = "prompt"');
        expect(file?.contents).toContain('prefix_rule(pattern = ["rm"], decision = "forbidden"');
        expect(gaps).toEqual([]);
    });

    it("decides as the rules do wherever it reports no gap", () => {
        const rules = [
            rule("shell", "npm *", "ask"),
            rule("shell", "npm test *", "allow"),
            rule("shell", "git *", "allow"),
            rule("shell", "git push *", "deny"),
            rule("edit", "*", "deny")
        ];
        const { file, gaps } = codexPolicy(rules);
        const flagged = new Set(gaps.map((gap) => gap.index));
        expect(gaps).toEqual([
            { cli: "codex", index: 0, kind: "stricter" },
            { cli: "codex", index: 4, kind: "unenforced" }
        ]);
        for (const command of ["git status", "git push origin", "git"]) {
            const want = evaluatePermission("shell", command, rules);
            const matched = rules.findLastIndex((entry) => entry.action === "shell" && new RegExp(`^${entry.resource.replace(/ \*$/, "( .*)?")}$`).test(command));
            if (flagged.has(matched)) continue;
            expect(codexDecide(file!.contents, command)).toBe(CODEX_EFFECT[want]);
        }
        // npm test is asked rather than allowed: stricter, as reported.
        expect(codexDecide(file!.contents, "npm test")).toBe("prompt");
    });

    it("says a deny it cannot narrow over more, and leaves out an allow it cannot", () => {
        const { file, gaps } = codexPolicy([rule("shell", "rm -rf *.tmp", "deny"), rule("shell", "ls", "allow")]);
        expect(file?.contents).toContain('prefix_rule(pattern = ["rm", "-rf"], decision = "forbidden"');
        expect(file?.contents).not.toContain('"ls"');
        expect(gaps).toEqual([
            { cli: "codex", index: 0, kind: "stricter" },
            { cli: "codex", index: 1, kind: "unenforced" }
        ]);
    });

    it("drops an allow a later deny it cannot write would have cut into", () => {
        const { file, gaps } = codexPolicy([rule("shell", "git *", "allow"), rule("shell", "*--force*", "deny")]);
        expect(file).toBeNull();
        expect(gaps).toEqual([
            { cli: "codex", index: 0, kind: "unenforced" },
            { cli: "codex", index: 1, kind: "unenforced" }
        ]);
    });

    it("writes nothing for rules on tools Codex has no equivalent for", () => {
        expect(codexPolicy([rule("mcp__github__create_issue", "*", "deny")])).toEqual({ file: null, gaps: [] });
        expect(cliPolicyFile("codex", [])).toBeNull();
    });
});

describe("Gemini CLI policy from an agent's rules", () => {
    it("writes one rule per tool, priority rising with the position", () => {
        const { file, gaps } = geminiPolicy([rule("edit", "*", "ask"), rule("shell", "git status *", "allow")]);
        expect(file?.path).toBe(".gemini/policies/polaris.toml");
        expect(file?.contents).toContain('toolName = ["write_file","replace"]\ndecision = "ask_user"');
        expect(file?.contents).toContain(`priority = ${GEMINI_PRIORITY_BASE}`);
        expect(file?.contents).toContain(`priority = ${GEMINI_PRIORITY_BASE + 1}`);
        expect(file?.contents).toContain('toolName = ["run_shell_command"]\ncommandRegex = ');
        expect(gaps).toEqual([]);
    });

    it("decides exactly as the last matching rule does", () => {
        const rules = [
            rule("*", "*", "ask"),
            rule("shell", "*", "allow"),
            rule("shell", "rm *", "deny"),
            rule("shell", "rm -i *", "ask"),
            rule("shell", "* --help", "allow"),
            rule("edit", "*.env", "deny"),
            rule("read", "src/*", "allow")
        ];
        const { file, gaps } = geminiPolicy(rules);
        expect(gaps).toEqual([{ cli: "gemini", index: 6, kind: "unenforced" }]);
        const shell = [
            "ls -la",
            "rm -rf /",
            "rm",
            "rm -i a",
            "rm x --help",
            'echo "a" --help',
            "rmdir x",
            "echo a\nrm b"
        ];
        for (const command of shell) {
            expect(geminiDecide(file!.contents, "run_shell_command", { command, description: "x --help" }), command).toBe(
                GEMINI_EFFECT[evaluatePermission("shell", command, rules)]
            );
        }
        for (const path of ["/w/.env", "/w/a.ts", 'a".env']) {
            expect(geminiDecide(file!.contents, "write_file", { file_path: path, content: "x" }), path).toBe(
                GEMINI_EFFECT[evaluatePermission("edit", path, rules)]
            );
        }
        expect(geminiDecide(file!.contents, "read_file", { file_path: "src/a.ts" })).toBe("allow");
        // read_many_files cannot be matched by path: the catch-all still asks.
        expect(geminiDecide(file!.contents, "read_many_files", { include: ["src/a.ts"] })).toBe("ask_user");
    });

    it("never lets a wildcard cross into another argument", () => {
        const regex = new RegExp(`"command":"${wildcardJsonRegex("* --help")}`);
        expect(regex.test(JSON.stringify({ command: "rm -rf /", description: "x --help" }))).toBe(false);
        expect(regex.test(JSON.stringify({ command: "rm --help" }))).toBe(true);
        expect(new RegExp(wildcardJsonRegex("a.b")).test('a.b"')).toBe(true);
        expect(new RegExp(`^${wildcardJsonRegex("a.b")}`).test('axb"')).toBe(false);
    });

    it("denies a whole tool where a pattern has no argument to match", () => {
        const { file, gaps } = geminiPolicy([rule("webfetch", "https://evil.example/*", "deny")]);
        expect(file?.contents).toContain('toolName = ["web_fetch"]\ndecision = "deny"');
        expect(gaps).toEqual([{ cli: "gemini", index: 0, kind: "stricter" }]);
    });

    it("reports gaps for both tools together", () => {
        expect(cliPolicyGaps([rule("webfetch", "https://a.example/*", "allow")])).toEqual([
            { cli: "codex", index: 0, kind: "unenforced" },
            { cli: "gemini", index: 0, kind: "unenforced" }
        ]);
    });
});
