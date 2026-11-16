// @vitest-environment node
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as rules from "@/lib/polar/native/rules";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MEMORY_MAX_CHARS, nativeSystemPrompt } from "@/lib/polar/native/prompt";

let base: string;
let home: string;
let repo: string;

beforeEach(async () => {
    base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "polar-rules-")));
    home = path.join(base, "home");
    repo = path.join(base, "work", "repo");
    await fs.mkdir(path.join(repo, ".git"), { recursive: true });
    await fs.mkdir(path.join(repo, "packages", "app"), { recursive: true });
    await fs.mkdir(home, { recursive: true });
});

afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const write = async (file: string, text: string) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
};

describe("discoverRules", () => {
    it("quotes the global file first, then the project's from nearest to the repository root", async () => {
        await write(path.join(home, ".polaris-agent", "AGENTS.md"), "global rules");
        await write(path.join(repo, "AGENTS.md"), "root rules");
        await write(path.join(repo, "packages", "app", "AGENTS.md"), "app rules");
        // Above the repository: never the project's.
        await write(path.join(base, "work", "AGENTS.md"), "outside");
        const found = rules.discoverRules({ cwd: path.join(repo, "packages", "app"), home });
        expect(found.map((rule) => rule.file)).toEqual(["~/.polaris-agent/AGENTS.md", "AGENTS.md", "../../AGENTS.md"]);
        expect(found.map((rule) => rule.text)).toEqual(["global rules", "app rules", "root rules"]);
    });

    it("takes the first rule file name found anywhere up the tree, as OpenCode does", async () => {
        await write(path.join(repo, "CLAUDE.md"), "claude root");
        await write(path.join(repo, "packages", "app", "CLAUDE.md"), "claude app");
        expect(rules.discoverRules({ cwd: path.join(repo, "packages", "app"), home }).map((rule) => rule.text)).toEqual(["claude app", "claude root"]);
        await write(path.join(repo, "AGENTS.md"), "agents root");
        expect(rules.discoverRules({ cwd: path.join(repo, "packages", "app"), home }).map((rule) => rule.text)).toEqual(["agents root"]);
    });

    it("falls back to ~/.claude/CLAUDE.md as the global file, and reads only one", async () => {
        await write(path.join(home, ".claude", "CLAUDE.md"), "claude global");
        expect(rules.discoverRules({ cwd: repo, home }).map((rule) => rule.file)).toEqual(["~/.claude/CLAUDE.md"]);
        await write(path.join(home, ".polaris-agent", "AGENTS.md"), "polar global");
        expect(rules.discoverRules({ cwd: repo, home }).map((rule) => rule.text)).toEqual(["polar global"]);
    });

    it("reads only the working directory outside a repository, and skips empty files", async () => {
        const plain = path.join(base, "plain", "inner");
        await write(path.join(plain, "AGENTS.md"), "inner");
        await write(path.join(base, "plain", "AGENTS.md"), "outer");
        expect(rules.discoverRules({ cwd: plain, home }).map((rule) => rule.text)).toEqual(["inner"]);
        await write(path.join(plain, "AGENTS.md"), "   \n");
        expect(rules.discoverRules({ cwd: plain, home })).toEqual([]);
    });

    it("bounds each file and the whole set, and reads a file reached twice once", async () => {
        await write(path.join(repo, "AGENTS.md"), "x".repeat(MEMORY_MAX_CHARS + 500));
        const [one] = rules.discoverRules({ cwd: repo, home });
        expect(one?.text.length).toBeLessThanOrEqual(MEMORY_MAX_CHARS + 10);
        expect(one?.text.endsWith("[cut]")).toBe(true);
        // The global folder inside the checkout: the walk meets the same file again.
        const nestedHome = repo;
        await write(path.join(repo, ".polaris-agent", "AGENTS.md"), "nested global");
        const found = rules.discoverRules({ cwd: path.join(repo, ".polaris-agent"), home: nestedHome });
        expect(found.filter((rule) => rule.text === "nested global")).toHaveLength(1);
    });

    it("lands in the system prompt in order, each under its own heading", async () => {
        await write(path.join(home, ".polaris-agent", "AGENTS.md"), "GLOBAL-MARK");
        await write(path.join(repo, "AGENTS.md"), "PROJECT-MARK");
        const memory = rules.discoverRules({ cwd: repo, home }).map(({ file, text }) => ({ file, text }));
        const prompt = nativeSystemPrompt({
            cwd: repo,
            platform: "linux",
            shell: "bash",
            branch: null,
            repository: null,
            place: "container",
            date: "2026-11-16",
            model: "test",
            planMode: false,
            memory
        });
        expect(prompt).toContain("# Instructions from: ~/.polaris-agent/AGENTS.md");
        expect(prompt).toContain("# Instructions from: AGENTS.md");
        expect(prompt.indexOf("GLOBAL-MARK")).toBeLessThan(prompt.indexOf("PROJECT-MARK"));
    });
});
