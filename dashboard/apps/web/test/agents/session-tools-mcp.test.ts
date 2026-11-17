import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { createInterface } from "node:readline";
import { createServer, type Server } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";

const placement = vi.hoisted(() => ({ sessionPlacement: vi.fn() }));
vi.mock("@/lib/agents/session-service", async (original) => ({
    ...(await original<typeof import("@/lib/agents/session-service")>()),
    sessionPlacement: placement.sessionPlacement
}));

import * as shared from "@/lib/polar/custom-tools/shared";
import * as commands from "@/lib/agents/session-commands";
import * as toolsMcp from "@/lib/agents/session-tools-mcp";
import { toolsServerSkipped } from "@/lib/agents/session-runtime";
import { claudeHookSettings, mcpConfig } from "@/lib/agents/session-hooks";

describe("registration", () => {
    it("adds the tool server beside Polaris's own only when asked, with the session's token", () => {
        expect(Object.keys((mcpConfig("https://p/mcp", "tok") as { mcpServers: object }).mcpServers)).toEqual(["polaris"]);
        const config = mcpConfig("https://p/mcp", "tok", { script: "/state/tools-mcp.mjs", url: "https://p/tools" }) as {
            mcpServers: Record<string, Record<string, unknown>>;
        };
        expect(config.mcpServers[toolsMcp.TOOLS_SERVER_NAME]).toEqual({
            type: "stdio",
            command: "node",
            args: ["/state/tools-mcp.mjs"],
            env: { POLARIS_TOOLS_URL: "https://p/tools", POLARIS_TOOLS_TOKEN: "tok" }
        });
    });

    it("lets Polaris ask about each call instead of the agent asking a second time", () => {
        const settings = claudeHookSettings("/state/hook.sh") as { permissions: { allow: string[] } };
        expect(settings.permissions.allow).toEqual(["mcp__polaris-tools", "mcp__polaris-browser"]);
    });
});

/** The boot's lines that choose the registration, run as the boot runs them. */
function bootLines(): string {
    const lines = commands.SESSION_SETUP.split("\n");
    const from = lines.findIndex((entry) => entry.includes(toolsMcp.TOOLS_NO_NODE_FILE) && entry.startsWith("rm -f"));
    const to = lines.findIndex((entry, at) => at > from && entry.startsWith('chmod 0600 "$POLARIS_STATE_DIR/settings.json"')) - 1;
    expect(from).toBeGreaterThanOrEqual(0);
    return lines.slice(from, to + 1).join("\n");
}

/** PATH without any folder that holds a `node`. */
function pathWithoutNode(): string {
    return (process.env.PATH ?? "")
        .split(delimiter)
        .filter((dir) => dir && !["node", "node.exe"].some((name) => existsSync(join(dir, name))))
        .join(delimiter);
}

const hasSh = spawnSync("sh", ["-c", "command -v base64 && command -v sed"], { encoding: "utf8" }).status === 0;

/** A Windows path as sh (and sed's replacement) takes it. */
const slash = (path: string) => path.replace(/\\/g, "/");

describe.skipIf(!hasSh)("the boot", () => {
    const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
    const env = (state: string, path: string) => ({
        ...process.env,
        PATH: path,
        POLARIS_STATE_DIR: slash(state),
        POLARIS_MCP_CONFIG: b64('{"mcpServers":{"polaris":{}}}'),
        POLARIS_MCP_TOOLS_CONFIG: b64(JSON.stringify({ mcpServers: { "polaris-tools": { args: [`${toolsMcp.STATE_DIR_MARK}/tools-mcp.mjs`] } } })),
        POLARIS_TOOLS_MCP: b64("// server")
    });

    it("registers the tool server where node runs, at the state folder's real path", () => {
        const state = mkdtempSync(join(tmpdir(), "polaris-tools-boot-"));
        writeFileSync(join(state, toolsMcp.TOOLS_NO_NODE_FILE), "");
        const done = spawnSync("sh", ["-c", bootLines()], { encoding: "utf8", env: env(state, process.env.PATH ?? "") });
        expect(done.status, done.stderr).toBe(0);
        const written = JSON.parse(readFileSync(join(state, "mcp.json"), "utf8"));
        expect(written.mcpServers["polaris-tools"].args).toEqual([`${slash(state)}/tools-mcp.mjs`]);
        expect(readFileSync(join(state, toolsMcp.TOOLS_SERVER_FILE), "utf8")).toBe("// server");
        expect(existsSync(join(state, toolsMcp.TOOLS_NO_NODE_FILE))).toBe(false);
    });

    it("leaves it out without node, and says why for the tools screen", () => {
        const state = mkdtempSync(join(tmpdir(), "polaris-tools-boot-"));
        const done = spawnSync("sh", ["-c", bootLines()], { encoding: "utf8", env: env(state, pathWithoutNode()) });
        expect(done.status, done.stderr).toBe(0);
        expect(JSON.parse(readFileSync(join(state, "mcp.json"), "utf8"))).toEqual({ mcpServers: { polaris: {} } });
        expect(existsSync(join(state, toolsMcp.TOOLS_SERVER_FILE))).toBe(false);
        expect(existsSync(join(state, toolsMcp.TOOLS_NO_NODE_FILE))).toBe(true);
    });

    it("clears the boot's copies before the agent starts", () => {
        expect(commands.SESSION_SETUP).toMatch(/unset [^\n]*POLARIS_MCP_TOOLS_CONFIG POLARIS_TOOLS_MCP/);
    });
});

describe("toolsServerSkipped", () => {
    it("reads the marker from the session's state folder", async () => {
        placement.sessionPlacement.mockResolvedValue({ id: "s1", place: "host", state: "running" });
        const run = vi.fn(async () => ({ code: 0, output: "skipped\n" }));
        expect(await toolsServerSkipped("s1", run)).toBe(true);
        expect(run).toHaveBeenCalledWith("s1", expect.stringContaining(`$HOME/.polaris/sessions/s1/polaris/${toolsMcp.TOOLS_NO_NODE_FILE}`));
        run.mockResolvedValue({ code: 0, output: "" });
        expect(await toolsServerSkipped("s1", run)).toBe(false);
    });

    it("is false for a computer, or a machine that did not answer", async () => {
        const run = vi.fn(async () => {
            throw new Error("down");
        });
        placement.sessionPlacement.mockResolvedValue({ id: "s1", place: "computer", state: "running" });
        expect(await toolsServerSkipped("s1", run)).toBe(false);
        expect(run).not.toHaveBeenCalled();
        placement.sessionPlacement.mockResolvedValue({ id: "s1", place: "local", state: "running" });
        expect(await toolsServerSkipped("s1", run)).toBe(false);
    });
});

describe.skipIf(!hasSh)("the tool server", () => {
    let server: Server;
    let url = "";
    const seen: { method: string; auth: string; body: string }[] = [];

    beforeAll(async () => {
        server = createServer((request, response) => {
            let body = "";
            request.on("data", (chunk) => (body += chunk));
            request.on("end", () => {
                seen.push({ method: request.method ?? "", auth: request.headers.authorization ?? "", body });
                response.setHeader("content-type", "application/json");
                if (request.method === "GET") {
                    response.end(JSON.stringify({ ok: true, tools: [{ name: "greet", description: "Hi", inputSchema: { type: "object" } }] }));
                    return;
                }
                const call = JSON.parse(body) as { name: string };
                if (call.name !== "greet") {
                    response.end(JSON.stringify({ ok: false, refusal: "Denied from Polaris." }));
                    return;
                }
                response.end(
                    JSON.stringify({
                        ok: true,
                        command: `printf 'hello\\n'; printf '\\n%s%s\\n' '${shared.EXIT_MARK}' 0`,
                        timeoutSeconds: 5
                    })
                );
            });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/tools`;
    });

    afterAll(() => server.close());

    it("answers MCP over stdio, listing and calling through Polaris", async () => {
        const dir = mkdtempSync(join(tmpdir(), "polaris-tools-mcp-"));
        const script = join(dir, toolsMcp.TOOLS_SERVER_FILE);
        writeFileSync(script, toolsMcp.toolsMcpScript());
        chmodSync(script, 0o600);
        const child = spawn(process.execPath, [script], {
            env: { ...process.env, POLARIS_TOOLS_URL: url, POLARIS_TOOLS_TOKEN: "tok" },
            stdio: ["pipe", "pipe", "inherit"]
        });
        const answers = new Map<number, Record<string, unknown>>();
        const waiting = new Map<number, (value: Record<string, unknown>) => void>();
        createInterface({ input: child.stdout }).on("line", (line) => {
            const message = JSON.parse(line) as { id: number };
            waiting.get(message.id)?.(message);
            answers.set(message.id, message);
        });
        const ask = (id: number, method: string, params?: unknown) =>
            new Promise<Record<string, unknown>>((resolve) => {
                waiting.set(id, resolve);
                child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
            });
        try {
            const init = await ask(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {} });
            expect(init.result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} } });
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
            const list = await ask(2, "tools/list");
            expect(list.result).toEqual({ tools: [{ name: "greet", description: "Hi", inputSchema: { type: "object" } }] });
            const called = await ask(3, "tools/call", { name: "greet", arguments: { who: "Ana" } });
            // The output as `toolCommand` frames it, read the way `readToolRun` reads it.
            expect(called.result).toEqual({ content: [{ type: "text", text: "hello\n" }], isError: false });
            const refused = await ask(4, "tools/call", { name: "other", arguments: {} });
            expect(refused.result).toEqual({ content: [{ type: "text", text: "Denied from Polaris." }], isError: true });
            const unknown = await ask(5, "resources/list");
            expect(unknown.error).toMatchObject({ code: -32601 });
            expect(seen.every((entry) => entry.auth === "Bearer tok")).toBe(true);
            expect(JSON.parse(seen.find((entry) => entry.method === "POST")!.body)).toEqual({ name: "greet", arguments: { who: "Ana" } });
        } finally {
            child.kill();
        }
    });
});
