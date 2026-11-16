// @vitest-environment node
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as lsp from "@/lib/polar/native/lsp";
import * as tools from "@/lib/polar/native/tools";
import * as format from "@/lib/polar/native/format";
import { editTooling } from "@/lib/polar/native/post-edit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nodeWorkspace, type Workspace } from "@/lib/polar/native/workspace";

const FAKE_LSP = path.join(__dirname, "fixtures", "fake-lsp.cjs");

let root: string;
let ws: Workspace;
let state: tools.SessionState;
let context: tools.ToolContext;
let logged: string[];

beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "polar-post-edit-")));
    ws = nodeWorkspace(root);
    state = tools.sessionState(root);
    context = { ws, state, signal: new AbortController().signal };
    logged = [];
    editTooling(ws, (line) => logged.push(line));
});

afterEach(async () => {
    editTooling(ws).lsp.shutdown();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const write = async (name: string, text: string) => {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
    return file;
};

/** An installed npm package whose `bin` is `script`. */
const install = async (name: string, bin: string, script: string) => {
    await write(path.join("node_modules", name, "package.json"), JSON.stringify({ name, bin: { [bin]: "cli.cjs" } }));
    await write(path.join("node_modules", name, "cli.cjs"), script);
};

// Uppercases the file it is given, so a run is visible in the content.
const UPPERCASER = 'const fs = require("fs"); const f = process.argv[process.argv.length - 1]; fs.writeFileSync(f, fs.readFileSync(f, "utf8").toUpperCase());';

describe("formatter after an edit", () => {
    it("runs the checkout's prettier on Write and Edit, says so, and keeps the read record current", async () => {
        await write("package.json", JSON.stringify({ devDependencies: { prettier: "*" } }));
        await install("prettier", "prettier", UPPERCASER);
        const target = path.join(root, "src", "a.ts");
        const created = await tools.writeTool.run({ file_path: target, content: "const a = 1;\n" }, context);
        expect(created.isError).toBeFalsy();
        expect(created.text).toContain("Formatted with prettier");
        expect(await fs.readFile(target, "utf8")).toBe("CONST A = 1;\n");
        // The next edit is not refused or flagged as drift because of the formatter.
        const edited = await tools.editTool.run({ file_path: target, old_string: "1", new_string: "two" }, context);
        expect(edited.isError).toBeFalsy();
        expect(edited.text).not.toContain("changed on disk");
        expect(await fs.readFile(target, "utf8")).toBe("CONST A = TWO;\n");
    });

    it("runs nothing when the tool is installed but not configured, or configured but not installed", async () => {
        await install("prettier", "prettier", UPPERCASER);
        const target = path.join(root, "a.ts");
        expect((await tools.writeTool.run({ file_path: target, content: "x\n" }, context)).text).toBe(`Created ${target}.`);
        expect(await fs.readFile(target, "utf8")).toBe("x\n");

        const bare = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "polar-post-edit-")));
        try {
            await fs.writeFile(path.join(bare, "package.json"), JSON.stringify({ devDependencies: { prettier: "*" } }));
            const found = await format.FORMATTERS.find((item) => item.name === "prettier")!.detect({ ws: nodeWorkspace(bare), dir: bare });
            expect(found).toBeNull();
        } finally {
            await fs.rm(bare, { recursive: true, force: true });
        }
    });

    it("never fails the write when the formatter fails, and logs it", async () => {
        await write("package.json", JSON.stringify({ devDependencies: { prettier: "*" } }));
        await install("prettier", "prettier", "process.exit(3);");
        const target = path.join(root, "a.ts");
        const result = await tools.writeTool.run({ file_path: target, content: "x\n" }, context);
        expect(result.isError).toBeFalsy();
        expect(result.text).toBe(`Created ${target}.`);
        expect(logged.some((line) => line.includes("prettier") && line.includes("exit 3"))).toBe(true);
    });

    it("ignores configuration above the checkout", async () => {
        const inner = path.join(root, "inner");
        await fs.mkdir(inner);
        await write("package.json", JSON.stringify({ devDependencies: { prettier: "*" } }));
        expect(await format.findUp({ ws: nodeWorkspace(inner), dir: inner }, "package.json")).toEqual([]);
        expect(await format.findUp({ ws, dir: inner }, "package.json")).toEqual([path.join(root, "package.json")]);
    });
});

describe("language server diagnostics", () => {
    it("frames and unframes base-protocol messages, split across chunks", () => {
        const seen: unknown[] = [];
        const reader = new lsp.FrameReader((message) => seen.push(message));
        const bytes = Buffer.from(lsp.frame({ a: "é" }) + lsp.frame({ b: 2 }));
        reader.push(bytes.subarray(0, 7));
        reader.push(bytes.subarray(7, 30));
        reader.push(bytes.subarray(30));
        expect(seen).toEqual([{ a: "é" }, { b: 2 }]);
    });

    it("hands back errors only, in OpenCode's form, capped", () => {
        const at = (line: number, severity: number, message: string) => ({ range: { start: { line, character: 0 } }, severity, message });
        expect(lsp.diagnosticsBlock([at(0, 2, "warn")])).toBe("");
        expect(lsp.diagnosticsBlock([at(4, 1, "broken"), at(1, 3, "info")])).toBe("This file has errors, please fix\n<file_diagnostics>\nERROR [5:1] broken\n</file_diagnostics>");
        const many = Array.from({ length: lsp.DIAGNOSTICS_MAX_SHOWN + 5 }, (_, index) => at(index, 1, "e"));
        expect(lsp.diagnosticsBlock(many)).toContain("... and 5 more");
    });

    it("starts the checkout's language server and feeds its errors back after Write and Edit", async () => {
        await write("package.json", JSON.stringify({ devDependencies: { typescript: "*", "typescript-language-server": "*" } }));
        await install("typescript", "tsc", "");
        await install("typescript-language-server", "typescript-language-server", await fs.readFile(FAKE_LSP, "utf8"));
        const target = path.join(root, "src", "a.ts");
        const created = await tools.writeTool.run({ file_path: target, content: "const ok = 1;\nconst BAD = 2;\nconst MEH = 3;\n" }, context);
        expect(created.isError).toBeFalsy();
        expect(created.text).toContain("<file_diagnostics>\nERROR [2:7] BAD is not allowed\n</file_diagnostics>");
        expect(created.text).not.toContain("MEH");
        // The same server answers the change; fixed code reports nothing.
        const fixed = await tools.editTool.run({ file_path: target, old_string: "BAD", new_string: "good" }, context);
        expect(fixed.text).toBe(`Edited ${target}: 1 replacement.`);
    }, 20_000);

    it("skips silently when no server is installed, or the one there does not start", async () => {
        await write("package.json", JSON.stringify({ devDependencies: { typescript: "*" } }));
        await install("typescript", "tsc", "");
        const target = path.join(root, "a.ts");
        const plain = await tools.writeTool.run({ file_path: target, content: "const BAD = 1;\n" }, context);
        expect(plain.text).toBe(`Created ${target}.`);

        await install("typescript-language-server", "typescript-language-server", "process.exit(1);");
        const pool = new lsp.LspPool(ws, (line) => logged.push(line));
        try {
            expect(await pool.diagnose(target)).toBe("");
            expect(logged.some((line) => line.includes("language server unavailable"))).toBe(true);
        } finally {
            pool.shutdown();
        }
    }, 20_000);
});
