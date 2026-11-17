import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { mkdtempSync, writeFileSync } from "node:fs";
import * as protocol from "@/lib/agents/session-browser-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browserMcpScript } from "@/lib/agents/session-browser-mcp";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

// The server runs as the container runs it, minus Chromium: PATH holds only
// Node, and installing is off, so every part but the browser itself is real.

const KEY = "test-browser-key";
let child: ChildProcessWithoutNullStreams;
let port = 0;
let nextId = 0;
const answers = new Map<number, (value: Record<string, unknown>) => void>();

function freePort(): Promise<number> {
    return new Promise((resolve) => {
        const server = createServer().listen(0, "127.0.0.1", () => {
            const address = server.address();
            server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
        });
    });
}

function rpc(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const id = ++nextId;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve) => answers.set(id, resolve));
}

function local(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, init);
}

async function listening(): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt++) {
        const ok = await local("/").then(
            () => true,
            () => false
        );
        if (ok) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("the browser server did not listen");
}

beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "polaris-browser-"));
    const script = join(dir, protocol.BROWSER_SERVER_FILE);
    writeFileSync(script, browserMcpScript());
    port = await freePort();
    child = spawn(process.execPath, [script], {
        env: {
            PATH: dirname(process.execPath),
            POLARIS_BROWSER_KEY: KEY,
            POLARIS_BROWSER_PORT: String(port),
            POLARIS_BROWSER_INSTALL: "0"
        },
        windowsHide: true
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
        const message = JSON.parse(line) as { id: number };
        answers.get(message.id)?.(message as never);
        answers.delete(message.id);
    });
    await listening();
}, 20_000);

afterAll(() => {
    child.stdin.end();
    child.kill();
});

describe("MCP", () => {
    it("introduces itself and lists the browser tools", async () => {
        const init = (await rpc("initialize", { protocolVersion: "2025-06-18" })) as { result: Record<string, unknown> };
        expect(init.result).toMatchObject({
            protocolVersion: "2025-06-18",
            serverInfo: { name: protocol.BROWSER_SERVER_NAME }
        });
        const list = (await rpc("tools/list")) as { result: { tools: unknown } };
        expect(list.result.tools).toEqual(JSON.parse(JSON.stringify(protocol.BROWSER_TOOLS)));
    });

    it("checks every call against the tool's schema", async () => {
        const unknownArg = (await rpc("tools/call", { name: "browser_navigate", arguments: { url: "x", extra: 1 } })) as {
            result: { isError: boolean; content: { text: string }[] };
        };
        expect(unknownArg.result.isError).toBe(true);
        expect(unknownArg.result.content[0]?.text).toMatch(/Unknown argument: extra/);
        const wrongType = (await rpc("tools/call", { name: "browser_scroll", arguments: { deltaY: "down" } })) as {
            result: { isError: boolean; content: { text: string }[] };
        };
        expect(wrongType.result.content[0]?.text).toMatch(/deltaY must be a number/);
        const missing = (await rpc("tools/call", { name: "browser_type", arguments: {} })) as {
            result: { content: { text: string }[] };
        };
        expect(missing.result.content[0]?.text).toMatch(/Missing argument: text/);
    });

    it("says so, without installing, on a machine Polaris does not own", async () => {
        const call = (await rpc("tools/call", { name: "browser_navigate", arguments: { url: "https://example.com" } })) as {
            result: { isError: boolean; content: { text: string }[] };
        };
        expect(call.result.isError).toBe(true);
        expect(call.result.content[0]?.text).toMatch(/no Chromium/);
    });
});

describe("stream listener", () => {
    it("answers nothing without the session's key", async () => {
        expect((await local("/stream")).status).toBe(401);
        expect((await local("/stream", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
        expect((await local("/input", { method: "POST", body: "{}" })).status).toBe(401);
    });

    it("streams the browser's state first, in the protocol the page decodes", async () => {
        const controller = new AbortController();
        const response = await local("/stream", { headers: { authorization: `Bearer ${KEY}` }, signal: controller.signal });
        expect(response.status).toBe(200);
        const reader = response.body!.getReader();
        const packets = new protocol.PacketReader();
        let first: protocol.BrowserPacket | undefined;
        while (!first) {
            const { value, done } = await reader.read();
            if (done) break;
            first = packets.push(value)[0];
        }
        controller.abort();
        expect(first).toEqual({
            kind: protocol.KIND_STATE,
            state: { status: "failed", url: "", title: "", agentDriving: false }
        });
    });

    it("relays only allow-listed commands, and only to a running browser", async () => {
        const post = (body: unknown) =>
            local("/input", {
                method: "POST",
                headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
                body: JSON.stringify(body)
            });
        expect((await post({ commands: [{ method: "Runtime.evaluate", params: { expression: "1" } }] })).status).toBe(400);
        expect((await post({ commands: [] })).status).toBe(400);
        const none = await post({ commands: [{ method: "Input.insertText", params: { text: "a" } }] });
        expect(none.status).toBe(409);
        expect(await none.json()).toEqual({ error: "no-browser" });
    });
});
