import { spawn } from "node:child_process";
import { FAKE_APP_SERVER } from "./stdio-pipe";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { CodexRpc, CodexRpcError, METHOD_NOT_FOUND, readCodexFrame } from "@/lib/agents/codex/rpc";

const children: { kill(): void }[] = [];
afterEach(() => {
    for (const child of children.splice(0)) child.kill();
});

/** The fake app-server on its own stdio, the client's streams wrapped round it. */
function connect(onRequest: (method: string, params: unknown) => Promise<unknown>) {
    const child = spawn(process.execPath, [FAKE_APP_SERVER], { stdio: "pipe" });
    children.push(child);
    const notifications: { method: string; params: unknown }[] = [];
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const rpc = new CodexRpc(
        {
            input: Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
            output: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
        },
        {
            onNotification: (method, params) => notifications.push({ method, params }),
            onRequest: (method, params) => onRequest(method, params)
        }
    );
    const sent = () =>
        stderr
            .split("\n")
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line) as Record<string, unknown>);
    return { rpc, notifications, sent };
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!check()) {
        if (Date.now() > deadline) throw new Error("timed out");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

describe("app-server frames", () => {
    it("takes frames with and without the jsonrpc header, and nothing else", () => {
        expect(readCodexFrame({ id: 1, result: {} })).not.toBeNull();
        expect(readCodexFrame({ jsonrpc: "2.0", method: "turn/started", params: {} })).not.toBeNull();
        expect(readCodexFrame({ id: "srv-1", method: "item/fileChange/requestApproval", params: {} })).not.toBeNull();
        expect(readCodexFrame({ id: 2, error: { code: -32600, message: "Not initialized" } })).not.toBeNull();
        expect(readCodexFrame({ jsonrpc: "1.0", id: 1, result: {} })).toBeNull();
        expect(readCodexFrame({ id: 1, result: {}, error: { code: 1, message: "x" } })).toBeNull();
        expect(readCodexFrame({ id: 1 })).toBeNull();
        expect(readCodexFrame({ method: "" })).toBeNull();
        expect(readCodexFrame("text")).toBeNull();
    });
});

describe("CodexRpc over a real stdio app-server", () => {
    it("handshakes, starts a thread and sends frames without the jsonrpc header", async () => {
        const { rpc, notifications, sent } = connect(async () => ({}));
        const init = (await rpc.request("initialize", { clientInfo: { name: "polaris", version: "1" } })) as {
            platformOs: string;
        };
        expect(init.platformOs).toBe("linux");
        await rpc.notify("initialized", {});
        const thread = (await rpc.request("thread/start", { cwd: "/work" })) as { thread: { id: string } };
        expect(thread.thread.id).toBe("thr_123");
        await until(() => notifications.some((entry) => entry.method === "thread/started"));
        await until(() => sent().length === 3);
        expect(sent().map((frame) => frame.method)).toEqual(["initialize", "initialized", "thread/start"]);
        expect(sent().every((frame) => !("jsonrpc" in frame))).toBe(true);
        rpc.close();
    });

    it("rejects a request the server answers with an error", async () => {
        const { rpc } = connect(async () => ({}));
        await expect(rpc.request("thread/start", {})).rejects.toBeInstanceOf(CodexRpcError);
        await expect(rpc.request("no/such", {})).rejects.toMatchObject({ code: METHOD_NOT_FOUND });
        rpc.close();
    });

    it("answers every server request, the unmodelled one with an error", async () => {
        const asked: string[] = [];
        const { rpc, notifications, sent } = connect(async (method) => {
            asked.push(method);
            if (method === "item/tool/requestUserInput") throw new CodexRpcError(METHOD_NOT_FOUND, "no");
            return { decision: "accept" };
        });
        await rpc.request("initialize", { clientInfo: { name: "polaris", version: "1" } });
        await rpc.notify("initialized", {});
        await rpc.request("thread/start", { cwd: "/work" });
        await rpc.request("turn/start", { threadId: "thr_123", input: [{ type: "text", text: "run tests" }] });
        await until(() => notifications.some((entry) => entry.method === "turn/completed"));
        expect(asked).toEqual(["item/tool/requestUserInput", "item/commandExecution/requestApproval"]);
        const replies = sent().filter((frame) => typeof frame.id === "string" && frame.id.startsWith("srv-"));
        expect(replies).toEqual([
            { id: "srv-1", error: { code: METHOD_NOT_FOUND, message: "no" } },
            { id: "srv-2", result: { decision: "accept" } }
        ]);
        rpc.close();
    });

    it("fails open requests when the server goes away", async () => {
        const { rpc } = connect(async () => ({}));
        const pending = rpc.request("initialize", { clientInfo: { name: "polaris", version: "1" } });
        children[0]!.kill();
        await pending.catch(() => undefined);
        await rpc.closed;
        await expect(rpc.request("thread/start", {})).rejects.toThrow();
    });
});
