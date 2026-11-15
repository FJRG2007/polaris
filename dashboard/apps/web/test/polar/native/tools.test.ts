// @vitest-environment node
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as tools from "@/lib/polar/native/tools";
import { nodeWorkspace, type Workspace } from "@/lib/polar/native/workspace";

let root: string;
let ws: Workspace;
let state: tools.SessionState;
let context: tools.ToolContext;

beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "polar-native-")));
    ws = nodeWorkspace(root);
    state = tools.sessionState(root);
    context = { ws, state, signal: new AbortController().signal };
});

afterEach(async () => {
    for (const job of state.shells.values()) job.process.kill();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const file = (name: string) => path.join(root, name);

describe("Read", () => {
    it("numbers lines, pages with offset and limit, and notes past-end and empty files", async () => {
        await fs.writeFile(file("a.txt"), "one\ntwo\nthree\n");
        expect((await tools.readTool.run({ file_path: file("a.txt") }, context)).text).toBe("     1\tone\n     2\ttwo\n     3\tthree");
        const paged = await tools.readTool.run({ file_path: file("a.txt"), offset: 2, limit: 1 }, context);
        expect(paged.text).toContain("     2\ttwo");
        expect(paged.text).toContain("PARTIAL view");
        expect((await tools.readTool.run({ file_path: file("a.txt"), offset: 9 }, context)).text).toContain("has 3 lines");
        await fs.writeFile(file("empty.txt"), "");
        expect((await tools.readTool.run({ file_path: file("empty.txt") }, context)).text).toContain("exists but is empty");
    });

    it("lists a directory, refuses binaries and missing files, resolves relative paths", async () => {
        await fs.mkdir(file("src"));
        await fs.writeFile(file("src/x.ts"), "x");
        expect((await tools.readTool.run({ file_path: root }, context)).text).toBe("src/");
        expect((await tools.readTool.run({ file_path: "src/x.ts" }, context)).text).toContain("\tx");
        await fs.writeFile(file("bin"), Buffer.from([1, 0, 2]));
        expect((await tools.readTool.run({ file_path: file("bin") }, context)).isError).toBe(true);
        expect((await tools.readTool.run({ file_path: file("nope") }, context)).isError).toBe(true);
    });
});

describe("Write and Edit", () => {
    it("creates a new file with its folders, and refuses to overwrite an unread one", async () => {
        expect((await tools.writeTool.run({ file_path: file("d/new.txt"), content: "hi" }, context)).text).toContain("Created");
        expect(await fs.readFile(file("d/new.txt"), "utf8")).toBe("hi");
        await fs.writeFile(file("old.txt"), "keep");
        expect((await tools.writeTool.run({ file_path: file("old.txt"), content: "x" }, context)).isError).toBe(true);
        await tools.readTool.run({ file_path: file("old.txt") }, context);
        expect((await tools.writeTool.run({ file_path: file("old.txt"), content: "x" }, context)).isError).toBeUndefined();
        expect(await fs.readFile(file("old.txt"), "utf8")).toBe("x");
    });

    it("needs a read, a match, and a unique one unless replace_all", async () => {
        await fs.writeFile(file("e.ts"), "a = 1;\nb = 1;\n");
        const edit = (input: Partial<Parameters<typeof tools.editTool.run>[0]>) =>
            tools.editTool.run({ file_path: file("e.ts"), old_string: "", new_string: "", ...input }, context);
        expect((await edit({ old_string: "a = 1", new_string: "a = 2" })).text).toContain("Read");
        await tools.readTool.run({ file_path: file("e.ts") }, context);
        expect((await edit({ old_string: "zzz", new_string: "y" })).text).toContain("not found");
        expect((await edit({ old_string: "= 1", new_string: "= 3" })).text).toContain("appears 2 times");
        expect((await edit({ old_string: "same", new_string: "same" })).isError).toBe(true);
        expect((await edit({ old_string: "a = 1", new_string: "a = $& 2" })).isError).toBeUndefined();
        expect(await fs.readFile(file("e.ts"), "utf8")).toBe("a = $& 2;\nb = 1;\n");
        expect((await edit({ old_string: "1", new_string: "9", replace_all: true })).text).toContain("1 replacement");
    });
});

describe("Glob", () => {
    it("matches ** and braces, newest first, and skips .git", async () => {
        await fs.mkdir(file("src/deep"), { recursive: true });
        await fs.mkdir(file(".git"));
        await fs.writeFile(file(".git/x.ts"), "");
        await fs.writeFile(file("src/a.ts"), "");
        await fs.writeFile(file("src/deep/b.tsx"), "");
        await fs.utimes(file("src/a.ts"), new Date(2000, 1, 1), new Date(2000, 1, 1));
        const found = (await tools.globTool.run({ pattern: "**/*.{ts,tsx}" }, context)).text.split("\n");
        expect(found).toEqual([file("src/deep/b.tsx"), file("src/a.ts")]);
        expect((await tools.globTool.run({ pattern: "*.md" }, context)).text).toBe("No files found.");
    });

    it("turns a glob into the regular expression it means", () => {
        expect(tools.globToRegExp("src/**/*.ts").test("src/a/b/c.ts")).toBe(true);
        expect(tools.globToRegExp("src/**/*.ts").test("src/c.ts")).toBe(true);
        expect(tools.globToRegExp("*.ts").test("a/b.ts")).toBe(false);
        expect(tools.globToRegExp("file?.[ab]").test("file1.a")).toBe(true);
    });
});

describe("Grep", () => {
    beforeEach(async () => {
        await fs.mkdir(file("src"));
        await fs.mkdir(file("node_modules"));
        await fs.writeFile(file("src/a.ts"), "const x = 1;\nfunction hello() {}\n");
        await fs.writeFile(file("src/b.py"), "def hello():\n    pass\n");
        await fs.writeFile(file("node_modules/c.ts"), "hello");
    });

    it("lists files, shows numbered lines, counts, and filters by glob and type", async () => {
        const grep = (input: Parameters<typeof tools.grepFallbackForTests>[0]) => tools.grepFallbackForTests(input, root, ws, context.signal);
        expect((await grep({ pattern: "hello" })).text.split("\n").sort()).toEqual([file("src/a.ts"), file("src/b.py")]);
        expect((await grep({ pattern: "hello", output_mode: "content", type: "ts" })).text).toBe(`${file("src/a.ts")}:2:function hello() {}`);
        expect((await grep({ pattern: "HELLO", "-i": true, glob: "*.py", output_mode: "count" })).text).toBe(`${file("src/b.py")}:1\nTotal: 1`);
        expect((await grep({ pattern: "(" })).isError).toBe(true);
        expect((await grep({ pattern: "absent" })).text).toBe("No files found.");
    });

    it("answers through ripgrep or the built-in search alike", async () => {
        const result = await tools.grepTool.run({ pattern: "function hello", output_mode: "files_with_matches" }, context);
        expect(result.text.replace(/\\/g, "/")).toContain("src/a.ts");
    });
});

describe("Bash", () => {
    it("runs a command, reports a failing exit code, and keeps a cd inside the project", async () => {
        await fs.mkdir(file("sub"));
        expect((await tools.bashTool.run({ command: "echo hi" }, context)).text).toBe("hi");
        const failed = await tools.bashTool.run({ command: "echo oops >&2; exit 3" }, context);
        expect(failed.isError).toBe(true);
        expect(failed.text).toContain("oops");
        expect(failed.text).toContain("Exit code 3");
        await tools.bashTool.run({ command: "cd sub" }, context);
        expect(path.basename(state.cwd)).toBe("sub");
        const reset = await tools.bashTool.run({ command: "cd /" }, context);
        expect(reset.text).toContain("Shell cwd was reset");
        expect(state.cwd).toBe(root);
    }, 30_000);

    it("stops a command at its timeout", async () => {
        const result = await tools.bashTool.run({ command: "sleep 5", timeout: 300 }, context);
        expect(result.isError).toBe(true);
        expect(result.text).toContain("timed out");
    }, 30_000);

    it("runs in the background, reads new output, and stops it", async () => {
        const started = await tools.bashTool.run({ command: "echo first; sleep 20", run_in_background: true }, context);
        const id = /shell_\d+/.exec(started.text)![0];
        let read = "";
        for (let attempt = 0; attempt < 50 && !read.includes("first"); attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            read += (await tools.bashOutputTool.run({ bash_id: id }, context)).text;
        }
        expect(read).toContain("first");
        expect(read).toContain("<status>running</status>");
        expect((await tools.killShellTool.run({ shell_id: id }, context)).text).toContain("Stopped");
        expect((await tools.bashOutputTool.run({ bash_id: id }, context)).isError).toBe(true);
    }, 30_000);
});

describe("TodoWrite and subagent tools", () => {
    it("keeps the whole list", async () => {
        const todos = [
            { content: "Run tests", status: "in_progress" as const, activeForm: "Running tests" },
            { content: "Fix", status: "completed" as const, activeForm: "Fixing" }
        ];
        expect((await tools.todoWriteTool.run({ todos }, context)).text).toContain("2 items, 1 open");
        expect(state.todos).toEqual(todos);
    });

    it("gives Explore read-only tools and never the asks or Task", () => {
        const names = (type?: "Explore" | "general-purpose") => tools.subagentTools(type).map((entry) => entry.name);
        expect(names("Explore")).toEqual(["Read", "Glob", "Grep", "Bash", "BashOutput"]);
        expect(names()).not.toContain("Task");
        expect(names()).not.toContain("AskUserQuestion");
        expect(names()).toContain("Edit");
    });
});
