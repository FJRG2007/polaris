import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agents/session-runtime", () => ({ runInSession: vi.fn() }));
vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/polar/custom-tools/store", () => ({ isApproved: vi.fn(async () => true) }));

import * as shared from "@/lib/polar/custom-tools/shared";
import * as runtime from "@/lib/polar/custom-tools/runtime";
import * as modules from "@/lib/polar/custom-tools/opencode-modules";

const line = (entry: Record<string, unknown>) => `polaris-module:${JSON.stringify(entry)}`;
const FLAT = {
    type: "object",
    properties: { query: { type: "string", description: "What to look for" }, mode: { type: "string", enum: ["a", "b"] } },
    required: ["query"]
};

describe("inputOf", () => {
    it("takes a flat object of strings, numbers and booleans", () => {
        expect(modules.inputOf(FLAT)).toEqual({
            type: "object",
            properties: { query: { type: "string", description: "What to look for" }, mode: { type: "string", enum: ["a", "b"] } },
            required: ["query"]
        });
        expect(modules.inputOf({ type: "object", properties: {} })).toEqual({ type: "object", properties: {}, required: [] });
    });

    it("refuses nested or untyped input, which Polaris cannot pass", () => {
        expect(modules.inputOf({ properties: { list: { type: "array", items: { type: "string" } } } })).toBeNull();
        expect(modules.inputOf({ properties: { any: {} } })).toBeNull();
        expect(modules.inputOf(null)).toBeNull();
        expect(modules.inputOf({ properties: { a: { type: "string" } }, required: ["missing"] })).toBeNull();
    });
});

describe("readModuleList", () => {
    const paths = [".opencode/tool/search.ts", ".opencode/tool/broken.ts", ".opencode/tool/quiet.ts"];

    it("names tools the way OpenCode does and reports the modules that gave none", () => {
        const output = [
            "some noise bun printed",
            line({ file: ".opencode/tool/search.ts", export: "default", description: "Search", schema: FLAT }),
            line({ file: ".opencode/tool/search.ts", export: "Deep", description: "Deep search", schema: FLAT }),
            line({ file: ".opencode/tool/search.ts", export: "nested", description: "x", schema: { properties: { a: { type: "object" } } } }),
            line({ file: ".opencode/tool/broken.ts", error: "load_failed" }),
            line({ file: ".opencode/tool/elsewhere.ts", export: "default", schema: FLAT }),
            "polaris-module:{not json"
        ].join("\n");
        const read = modules.readModuleList(output, paths, "s1", new Set());
        expect(read.tools.map((entry) => [entry.name, entry.runtime, entry.path, entry.permission])).toEqual([
            ["search", "bun", ".opencode/tool/search.ts", "ask"],
            ["search_deep", "bun", ".opencode/tool/search.ts", "ask"]
        ]);
        expect(read.tools[0].script).toContain('mod["default"]');
        expect(read.tools[0].script).toContain('"s1"');
        expect(read.unavailable).toEqual([
            { path: ".opencode/tool/search.ts#nested", reason: "input" },
            { path: ".opencode/tool/broken.ts", reason: "load_failed" },
            { path: ".opencode/tool/quiet.ts", reason: "load_failed" }
        ]);
    });

    it("never takes a name already in use, and says the repository lacks zod", () => {
        const output = [
            line({ file: ".opencode/tool/search.ts", export: "default", schema: FLAT }),
            line({ file: ".opencode/tool/broken.ts", error: "no_zod" })
        ].join("\n");
        const read = modules.readModuleList(output, paths.slice(0, 2), "s1", new Set(["search"]));
        expect(read.tools).toEqual([]);
        expect(read.unavailable).toEqual([
            { path: ".opencode/tool/search.ts#default", reason: "name" },
            { path: ".opencode/tool/broken.ts", reason: "no_zod" }
        ]);
    });
});

describe("moduleListCommand", () => {
    it("runs the listing with Bun in the checkout, bounded in time", () => {
        const command = modules.moduleListCommand([".opencode/tool/search.ts"]);
        expect(command).toContain('cd "${POLARIS_WORKDIR:-$HOME}"');
        expect(command).toContain("timeout 60 bun");
        const program = Buffer.from(/printf '%s' '([A-Za-z0-9+/=]+)'/.exec(command)![1], "base64").toString("utf8");
        expect(program).toContain('[".opencode/tool/search.ts"]');
    });
});

describe("parseProjectTools modules", () => {
    it("lists OpenCode's modules, and not the scripts a manifest names", () => {
        const parsed = shared.parseProjectTools([
            { path: ".opencode/tool/count.json", contents: JSON.stringify({ description: "Count", file: "count.mjs" }) },
            { path: ".opencode/tool/count.mjs", contents: "console.log(1)" },
            { path: ".opencode/tools/search.ts", contents: "export default {}" },
            { path: ".opencode/tool/a.js", contents: "export default {}" },
            { path: ".polaris/tools/x.ts", contents: "export default {}" }
        ]);
        expect(parsed.tools.map((entry) => entry.name)).toEqual(["count"]);
        expect(parsed.modules).toEqual([".opencode/tool/a.js", ".opencode/tools/search.ts"]);
    });
});

describe("readHasBun", () => {
    it("reads the line the file listing starts with", () => {
        expect(shared.readHasBun(`${shared.BUN_MARK}1\n.polaris/tools/a.json\tabc\n`)).toBe(true);
        expect(shared.readHasBun(`${shared.BUN_MARK}0\n`)).toBe(false);
        expect(shared.readHasBun("")).toBe(false);
        expect(shared.projectFilesCommand()).toContain(shared.BUN_MARK);
        // The mark is never read as a file.
        expect(shared.readProjectFiles(`${shared.BUN_MARK}1\n`)).toEqual([]);
    });
});

describe("projectOffer", () => {
    const sandbox = { sessionId: "s1", repository: "r1" };
    const review = (over: Partial<runtime.ProjectReview>): runtime.ProjectReview => ({
        tools: [],
        refused: [],
        modules: [".opencode/tool/search.ts"],
        digest: "0".repeat(64),
        approved: true,
        files: [],
        hasBun: true,
        ...over
    });

    it("imports nothing before the approval, nor without Bun", async () => {
        const run = vi.fn();
        expect(await runtime.projectOffer(sandbox, review({ approved: false }), run)).toEqual({ tools: [], unavailable: [] });
        expect(await runtime.projectOffer(sandbox, review({ hasBun: false }), run)).toEqual({
            tools: [],
            unavailable: [{ path: ".opencode/tool/search.ts", reason: "no_bun" }]
        });
        expect(run).not.toHaveBeenCalled();
    });

    it("adds the modules' tools once approved, and says when the listing failed", async () => {
        const run = vi.fn(async () => ({
            code: 0,
            output: line({ file: ".opencode/tool/search.ts", export: "default", description: "Search", schema: FLAT })
        }));
        const offer = await runtime.projectOffer(sandbox, review({}), run);
        expect(offer.tools.map((entry) => entry.name)).toEqual(["search"]);
        expect(run).toHaveBeenCalledWith("s1", expect.stringContaining("bun"));
        const down = vi.fn(async () => {
            throw new Error("unreachable");
        });
        expect((await runtime.projectOffer(sandbox, review({}), down)).unavailable).toEqual([
            { path: ".opencode/tool/search.ts", reason: "load_failed" }
        ]);
    });
});
