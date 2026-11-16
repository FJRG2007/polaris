import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ findFirst: vi.fn() }));
const perms = vi.hoisted(() => ({ open: vi.fn(), wait: vi.fn() }));
const offer = vi.hoisted(() => ({ sandboxTools: vi.fn() }));

vi.mock("@polaris/db", () => ({ prisma: { agentPermissionRequest: { findFirst: db.findFirst } } }));
vi.mock("@/lib/agents/session-permissions", () => ({
    PERMISSION_WAIT_MS: 120_000,
    openPermissionRequest: perms.open,
    awaitPermission: perms.wait
}));
vi.mock("@/lib/agents/agent-notices", () => ({ pushPermissionRequest: vi.fn(async () => undefined) }));
vi.mock("@/lib/polar/custom-tools/runtime", () => ({ sandboxTools: offer.sandboxTools }));

import * as shared from "@/lib/polar/custom-tools/shared";
import * as sessionTools from "@/lib/polar/custom-tools/session-tools";

const tool = (permission: "ask" | "allow") =>
    shared.customToolSchema.parse({
        name: "greet",
        description: "Says hello",
        input: { properties: { who: { type: "string" } }, required: ["who"] },
        script: "echo hi",
        permission
    });

const SESSION: sessionTools.ToolSession = { id: "s1", startedById: "u1", place: "local", repoId: "r1" };

beforeEach(() => {
    vi.clearAllMocks();
    db.findFirst.mockResolvedValue(null);
    perms.open.mockResolvedValue("req1");
});

describe("a session on somebody's computer", () => {
    it("is refused in words, before anything is read", async () => {
        const computer = { ...SESSION, place: "computer" };
        expect(await sessionTools.listSessionTools(computer)).toEqual({ ok: false, refusal: sessionTools.COMPUTER_REFUSAL });
        expect(await sessionTools.prepareSessionCall(computer, "greet", { who: "Ana" })).toEqual({
            ok: false,
            refusal: sessionTools.COMPUTER_REFUSAL
        });
        expect(offer.sandboxTools).not.toHaveBeenCalled();
    });
});

describe("listSessionTools", () => {
    it("lists each tool with its input as JSON Schema", async () => {
        offer.sandboxTools.mockResolvedValue({ tools: [{ definition: tool("ask"), fromProject: false, asks: true }], unavailable: [] });
        expect(await sessionTools.listSessionTools(SESSION)).toEqual({
            ok: true,
            tools: [
                {
                    name: "greet",
                    description: "Says hello",
                    inputSchema: {
                        type: "object",
                        properties: { who: { type: "string" } },
                        required: ["who"],
                        additionalProperties: false
                    }
                }
            ],
            unavailable: []
        });
        expect(offer.sandboxTools).toHaveBeenCalledWith("u1", { sessionId: "s1", repository: "r1" });
    });
});

describe("prepareSessionCall", () => {
    it("asks on the session, and runs nothing it was denied", async () => {
        offer.sandboxTools.mockResolvedValue({ tools: [{ definition: tool("ask"), fromProject: false, asks: true }], unavailable: [] });
        perms.wait.mockResolvedValue({ status: "deny" });
        const denied = await sessionTools.prepareSessionCall(SESSION, "greet", { who: "Ana" });
        expect(denied.ok).toBe(false);
        expect(perms.open).toHaveBeenCalledWith("s1", {
            tool: shared.turnToolName("greet"),
            detail: 'greet {"who":"Ana"}',
            suggestions: null
        });
        perms.wait.mockResolvedValue({ status: "allow" });
        const allowed = await sessionTools.prepareSessionCall(SESSION, "greet", { who: "Ana" });
        expect(allowed).toMatchObject({ ok: true, timeoutSeconds: 60 });
    });

    it("does not ask again after an always for that tool", async () => {
        offer.sandboxTools.mockResolvedValue({ tools: [{ definition: tool("ask"), fromProject: false, asks: true }], unavailable: [] });
        db.findFirst.mockResolvedValue({ id: "old" });
        expect((await sessionTools.prepareSessionCall(SESSION, "greet", { who: "Ana" })).ok).toBe(true);
        expect(perms.open).not.toHaveBeenCalled();
    });

    it("answers the command straight away for a tool set to allow", async () => {
        offer.sandboxTools.mockResolvedValue({ tools: [{ definition: tool("allow"), fromProject: false, asks: false }], unavailable: [] });
        const prepared = await sessionTools.prepareSessionCall(SESSION, "greet", { who: "Ana" });
        expect(prepared.ok && prepared.command).toBe(shared.toolCommand(tool("allow"), { who: "Ana" }));
        expect(perms.open).not.toHaveBeenCalled();
    });

    it("refuses an unknown tool or input it does not take, without asking", async () => {
        offer.sandboxTools.mockResolvedValue({ tools: [{ definition: tool("ask"), fromProject: false, asks: true }], unavailable: [] });
        expect((await sessionTools.prepareSessionCall(SESSION, "other", {})).ok).toBe(false);
        expect((await sessionTools.prepareSessionCall(SESSION, "greet", { who: 1 })).ok).toBe(false);
        expect((await sessionTools.prepareSessionCall(SESSION, "greet", { who: "Ana", extra: true })).ok).toBe(false);
        expect(perms.open).not.toHaveBeenCalled();
    });
});
