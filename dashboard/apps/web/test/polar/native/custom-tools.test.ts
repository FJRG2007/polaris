import { describe, expect, it, vi } from "vitest";
import * as shared from "@/lib/polar/custom-tools/shared";
import type { ToolContext } from "@/lib/polar/native/tools";
import type { Workspace } from "@/lib/polar/native/workspace";
import { fetchCustomTools, nativeCustomTool } from "@/lib/polar/native/custom-tools";

const LISTED = {
    name: "greet",
    description: "Says hello",
    inputSchema: { type: "object", properties: { who: { type: "string" } }, required: ["who"], additionalProperties: false }
};

/** A workspace that only runs commands, answering what it was given. */
function fakeWs(stdout: string): { ws: Workspace; exec: ReturnType<typeof vi.fn> } {
    const exec = vi.fn(async () => ({ code: 0, stdout, stderr: "" }));
    return { ws: { root: "/w", platform: "linux", exec } as unknown as Workspace, exec };
}

const context = (ws: Workspace) => ({ ws, signal: new AbortController().signal }) as unknown as ToolContext;

describe("nativeCustomTool", () => {
    it("is named as Polar chat names it, takes only its declared input, and leaves the asking to Polaris", () => {
        const tool = nativeCustomTool(LISTED, vi.fn())!;
        expect(tool.name).toBe(shared.turnToolName("greet"));
        expect(tool.gate).toBe("none");
        expect(tool.writes).toBe(true);
        expect(tool.schema.safeParse({ who: "Ana" }).success).toBe(true);
        expect(tool.schema.safeParse({ who: 1 }).success).toBe(false);
    });

    it("refuses an input Polaris does not describe", () => {
        expect(nativeCustomTool({ ...LISTED, inputSchema: { properties: { a: { type: "object" } }, required: [] } }, vi.fn())).toBeNull();
    });

    it("runs the command Polaris answered, in the checkout, and reads the exit back", async () => {
        const post = vi.fn(async () => ({ ok: true, command: "echo hello", timeoutSeconds: 10 }));
        const { ws, exec } = fakeWs(`hello\n${shared.EXIT_MARK}0\n`);
        const tool = nativeCustomTool(LISTED, post)!;
        expect(await tool.run({ who: "Ana" } as never, context(ws))).toEqual({ text: "hello" });
        expect(post).toHaveBeenCalledWith({ name: "greet", arguments: { who: "Ana" } }, expect.anything());
        expect(exec).toHaveBeenCalledWith(["/bin/sh", "-c", "echo hello"], expect.objectContaining({ timeoutMs: 40_000 }));
    });

    it("hands the refusal back as an error and runs nothing", async () => {
        const { ws, exec } = fakeWs("");
        const denied = nativeCustomTool(LISTED, vi.fn(async () => ({ ok: false, refusal: "Denied from Polaris." })))!;
        expect(await denied.run({ who: "Ana" } as never, context(ws))).toEqual({ text: "Denied from Polaris.", isError: true });
        const unreachable = nativeCustomTool(LISTED, vi.fn(async () => Promise.reject(new Error("down"))))!;
        expect((await unreachable.run({ who: "Ana" } as never, context(ws))).isError).toBe(true);
        expect(exec).not.toHaveBeenCalled();
    });

    it("says a run that failed or ran out of time did", async () => {
        const post = vi.fn(async () => ({ ok: true, command: "x", timeoutSeconds: 5 }));
        const tool = nativeCustomTool(LISTED, post)!;
        const slow = await tool.run({ who: "Ana" } as never, context(fakeWs(`${shared.EXIT_MARK}124\n`).ws));
        expect(slow).toMatchObject({ isError: true, text: expect.stringContaining("ran past 5 s") });
        const failed = await tool.run({ who: "Ana" } as never, context(fakeWs(`${shared.EXIT_MARK}2\n`).ws));
        expect(failed).toEqual({ text: "Exited with 2.", isError: true });
    });
});

describe("fetchCustomTools", () => {
    it("reads the session's tools with its token", async () => {
        const fetchImpl = vi.fn(async () => Response.json({ ok: true, tools: [LISTED], unavailable: [] }));
        const tools = await fetchCustomTools("https://p/tools", "tok", fetchImpl as unknown as typeof fetch);
        expect(tools.map((entry) => entry.name)).toEqual([shared.turnToolName("greet")]);
        expect(fetchImpl).toHaveBeenCalledWith("https://p/tools", expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer tok" }) }));
    });

    it("starts without them when Polaris refuses or cannot be reached", async () => {
        const refused = vi.fn(async () => Response.json({ ok: false, refusal: "no" }, { status: 401 }));
        expect(await fetchCustomTools("https://p/tools", "tok", refused as unknown as typeof fetch)).toEqual([]);
        const down = vi.fn(async () => {
            throw new Error("ECONNREFUSED");
        });
        expect(await fetchCustomTools("https://p/tools", "tok", down as unknown as typeof fetch)).toEqual([]);
    });
});
