import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agents/session-runtime", () => ({ runInSession: vi.fn() }));
vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/polar/custom-tools/store", () => ({ isApproved: vi.fn(async () => false) }));

import * as shared from "@/lib/polar/custom-tools/shared";
import * as runtime from "@/lib/polar/custom-tools/runtime";

const TOOL = shared.customToolSchema.parse({
    name: "greet",
    description: "Says hello",
    input: { properties: { who: { type: "string" } }, required: ["who"] },
    script: "echo hi"
});
const SANDBOX = { sessionId: "s1", repository: "r1" };

describe("runTool", () => {
    it("never reaches the sandbox with input the tool does not take", async () => {
        const run = vi.fn();
        const outcome = await runtime.runTool(SANDBOX, TOOL, { who: 1 }, run);
        expect(outcome.ok).toBe(false);
        expect(run).not.toHaveBeenCalled();
    });

    it("runs in the session it was given and reads the exit code back", async () => {
        const run = vi.fn(async () => ({ code: 0, output: `hello\n${shared.EXIT_MARK}0\n` }));
        expect(await runtime.runTool(SANDBOX, TOOL, { who: "Ana" }, run)).toEqual({ ok: true, text: "hello" });
        expect(run).toHaveBeenCalledWith("s1", expect.stringContaining("timeout 60 sh"));
    });

    it("says a run was stopped for its time, and hides a failure's internals", async () => {
        const slow = vi.fn(async () => ({ code: 0, output: `${shared.EXIT_MARK}124\n` }));
        expect((await runtime.runTool(SANDBOX, TOOL, { who: "Ana" }, slow)).text).toContain("was stopped");
        const broken = vi.fn(async () => {
            throw new Error("ssh: /home/someone/.ssh/id_rsa refused");
        });
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        const outcome = await runtime.runTool(SANDBOX, TOOL, { who: "Ana" }, broken);
        expect(outcome.ok).toBe(false);
        expect(outcome.text).not.toContain("id_rsa");
    });
});

describe("project review", () => {
    it("reads the checkout's tool files and is unapproved until the person says yes", async () => {
        const listing = `.polaris/tools/lint.json\t${Buffer.from(JSON.stringify({ description: "Lint", script: "npm run lint" })).toString("base64")}\n`;
        const run = vi.fn(async () => ({ code: 0, output: listing }));
        const review = await runtime.reviewProjectTools("u1", SANDBOX, run);
        expect(review?.tools.map((entry) => entry.name)).toEqual(["lint"]);
        expect(review?.approved).toBe(false);
        expect(review?.digest).toMatch(/^[0-9a-f]{64}$/);
    });

    it("has nothing to review for a session with no repository", async () => {
        const run = vi.fn();
        expect(await runtime.reviewProjectTools("u1", { sessionId: "s1", repository: null }, run)).toBeNull();
        expect(run).not.toHaveBeenCalled();
    });
});

describe("offered", () => {
    it("never offers a tool set to deny, or one switched off", () => {
        expect(runtime.offered({ enabled: true, permission: "ask" })).toBe(true);
        expect(runtime.offered({ enabled: true, permission: "deny" })).toBe(false);
        expect(runtime.offered({ enabled: false, permission: "allow" })).toBe(false);
    });
});
