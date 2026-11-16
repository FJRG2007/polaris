// @vitest-environment node
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { MockLanguageModelV4 } from "ai/test";
import * as acp from "@agentclientprotocol/sdk";
import { validatedFrames } from "@/lib/agents/acp/frames";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    acpEnvSchema,
    assistantText,
    checkAcpAccess,
    createAcpAgent,
    describeCall,
    mcpNotice,
    permissionDecision,
    promptText,
    readAcpEnv,
    replayUpdates,
    type AcpStore
} from "@/lib/polar/native/acp-agent";

const USAGE = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 }
};

type Step = { text?: string; calls?: { name: string; input: unknown }[] };

/** A model that answers a fixed script, one step per call, and records the
 *  prompts it was sent. */
function scripted(steps: Step[]) {
    let at = 0;
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV4({
        doGenerate: async (options) => {
            prompts.push(options.prompt);
            const step = steps[at++] ?? { text: "Done." };
            const calls = step.calls ?? [];
            return {
                content: [
                    ...(step.text ? [{ type: "text" as const, text: step.text }] : []),
                    ...calls.map((call, index) => ({
                        type: "tool-call" as const,
                        toolCallId: `call-${at}-${index}`,
                        toolName: call.name,
                        input: JSON.stringify(call.input)
                    }))
                ],
                finishReason: calls.length
                    ? { unified: "tool-calls" as const, raw: "tool_use" }
                    : { unified: "stop" as const, raw: "stop" },
                usage: USAGE,
                warnings: []
            };
        }
    });
    return { model, prompts };
}

/** Two byte pipes, the way an editor and its agent subprocess are joined:
 *  the agent's side is framed and validated exactly as `runAcp` does it. */
function pipes() {
    const toAgent = new TransformStream<Uint8Array, Uint8Array>();
    const toClient = new TransformStream<Uint8Array, Uint8Array>();
    const dropped: string[] = [];
    const framed = acp.ndJsonStream(toClient.writable, toAgent.readable);
    const agentStream: acp.Stream = {
        writable: framed.writable,
        readable: framed.readable.pipeThrough(validatedFrames((what) => dropped.push(what)))
    };
    return { toAgent, toClient, agentStream, dropped };
}

interface Editor {
    updates: acp.SessionUpdate[];
    permissions: acp.RequestPermissionRequest[];
    reads: string[];
    writes: { path: string; content: string }[];
    terminals: acp.CreateTerminalRequest[];
    released: string[];
}

function editor(answer: string | null, files: Record<string, string> = {}) {
    const seen: Editor = { updates: [], permissions: [], reads: [], writes: [], terminals: [], released: [] };
    const app = acp
        .client({ name: "test-editor" })
        .onNotification(acp.methods.client.session.update, ({ params }) => void seen.updates.push(params.update))
        .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
            seen.permissions.push(params);
            return answer
                ? { outcome: { outcome: "selected", optionId: answer } }
                : { outcome: { outcome: "cancelled" } };
        })
        .onRequest(acp.methods.client.fs.readTextFile, ({ params }) => {
            seen.reads.push(params.path);
            const content = files[params.path];
            if (content === undefined) throw acp.RequestError.resourceNotFound(params.path);
            return { content };
        })
        .onRequest(acp.methods.client.fs.writeTextFile, ({ params }) => {
            seen.writes.push({ path: params.path, content: params.content });
            return {};
        })
        .onRequest(acp.methods.client.terminal.create, ({ params }) => {
            seen.terminals.push(params);
            return { terminalId: `term-${seen.terminals.length}` };
        })
        .onRequest(acp.methods.client.terminal.waitForExit, () => ({ exitCode: 0 }))
        .onRequest(acp.methods.client.terminal.output, () => ({ output: "hello from the editor\n", truncated: false }))
        .onRequest(acp.methods.client.terminal.kill, () => ({}))
        .onRequest(acp.methods.client.terminal.release, ({ params }) => {
            seen.released.push(params.terminalId);
            return {};
        });
    return { app, seen };
}

/** Transcripts kept in memory, shared across connections like the folder is. */
function memoryStore(): AcpStore & { files: Map<string, string> } {
    const files = new Map<string, string>();
    return {
        files,
        append: (id, line) => void files.set(id, `${files.get(id) ?? ""}${line}\n`),
        read: (id) => files.get(id) ?? null
    };
}

let root: string;

beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "polar-acp-")));
});
afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

/** The agent behind a stdio-shaped pipe, and an editor connected to it. */
function connect(
    steps: Step[],
    answer: string | null,
    capabilities: acp.ClientCapabilities,
    files?: Record<string, string>,
    store: AcpStore = memoryStore()
) {
    const { model, prompts } = scripted(steps);
    const wire = pipes();
    let ids = 0;
    createAcpAgent({ model: () => model, modelName: "polar", newId: () => `s-${++ids}`, rules: () => [], store }).connect(
        wire.agentStream
    );
    const { app, seen } = editor(answer, files);
    const connection = app.connect(acp.ndJsonStream(wire.toAgent.writable, wire.toClient.readable));
    const agent = connection.agent;
    const start = async () => {
        const init = await agent.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: capabilities
        });
        const session = await agent.request(acp.methods.agent.session.new, { cwd: root, mcpServers: [] });
        return { init, session };
    };
    return { agent, connection, seen, prompts, start, dropped: wire.dropped };
}

const NO_CAPS: acp.ClientCapabilities = { fs: { readTextFile: false, writeTextFile: false }, terminal: false };
const ALL_CAPS: acp.ClientCapabilities = { fs: { readTextFile: true, writeTextFile: true }, terminal: true };

describe("Polar as an ACP agent", () => {
    it("answers initialize and opens a session with the engine's modes", async () => {
        const run = connect([], null, NO_CAPS);
        const { init, session } = await run.start();
        expect(init.protocolVersion).toBe(acp.PROTOCOL_VERSION);
        expect(init.agentCapabilities?.loadSession).toBe(true);
        expect(init.agentCapabilities?.mcpCapabilities).toEqual({ http: false, sse: false });
        expect(init.agentCapabilities?.promptCapabilities?.image).toBe(false);
        expect(session.sessionId).toBe("s-1");
        expect(session.modes?.currentModeId).toBe("default");
        expect(session.modes?.availableModes.map((mode) => mode.id)).toEqual([
            "default",
            "acceptEdits",
            "plan",
            "bypassPermissions"
        ]);
        run.connection.close();
    });

    it("streams the answer and ends the turn", async () => {
        const run = connect([{ text: "Hello from Polar." }], null, NO_CAPS);
        const { session } = await run.start();
        const done = await run.agent.request(acp.methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "Say hi" }]
        });
        expect(done.stopReason).toBe("end_turn");
        expect(run.seen.updates).toContainEqual({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Hello from Polar." }
        });
        run.connection.close();
    });

    it("asks session/request_permission before a write, and writes through the editor", async () => {
        const target = path.join(root, "notes.md");
        const run = connect(
            [{ calls: [{ name: "Write", input: { file_path: target, content: "# Notes\n" } }] }, { text: "Written." }],
            "allow",
            ALL_CAPS
        );
        const { session } = await run.start();
        const done = await run.agent.request(acp.methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "Write notes" }]
        });
        expect(done.stopReason).toBe("end_turn");
        expect(run.seen.permissions).toHaveLength(1);
        const asked = run.seen.permissions[0]!;
        expect(asked.toolCall.kind).toBe("edit");
        expect(asked.toolCall.locations).toEqual([{ path: target }]);
        expect(asked.options.map((option) => option.kind)).toEqual(["allow_once", "allow_always", "reject_once"]);
        expect(run.seen.writes).toEqual([{ path: target, content: "# Notes\n" }]);
        // The editor wrote it; the disk was never touched.
        await expect(fs.stat(target)).rejects.toThrow();
        const kinds = run.seen.updates.map((update) => update.sessionUpdate);
        expect(kinds).toContain("tool_call");
        expect(run.seen.updates).toContainEqual(
            expect.objectContaining({ sessionUpdate: "tool_call_update", status: "completed" })
        );
        run.connection.close();
    });

    it("refuses the call when the person rejects it, and tells the model", async () => {
        const target = path.join(root, "nope.md");
        const run = connect(
            [{ calls: [{ name: "Write", input: { file_path: target, content: "x" } }] }, { text: "Understood." }],
            "reject",
            ALL_CAPS
        );
        const { session } = await run.start();
        await run.agent.request(acp.methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "Write" }]
        });
        expect(run.seen.writes).toEqual([]);
        expect(run.seen.updates).toContainEqual(
            expect.objectContaining({ sessionUpdate: "tool_call_update", status: "failed" })
        );
        expect(JSON.stringify(run.prompts[1])).toContain("The user rejected this call");
        run.connection.close();
    });

    it("reads the editor's buffer instead of the disk", async () => {
        const file = path.join(root, "a.txt");
        await fs.writeFile(file, "on disk\n");
        const run = connect(
            [{ calls: [{ name: "Read", input: { file_path: file } }] }, { text: "Read it." }],
            null,
            ALL_CAPS,
            { [file]: "unsaved in the editor\n" }
        );
        const { session } = await run.start();
        await run.agent.request(acp.methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "Read a.txt" }]
        });
        expect(run.seen.reads).toContain(file);
        expect(run.seen.permissions).toHaveLength(0);
        expect(JSON.stringify(run.prompts[1])).toContain("unsaved in the editor");
        run.connection.close();
    });

    it("runs a command in an editor terminal and shows it on the call", async () => {
        const run = connect(
            [{ calls: [{ name: "Bash", input: { command: "echo hi" } }] }, { text: "Ran it." }],
            "allow",
            ALL_CAPS
        );
        const { session } = await run.start();
        await run.agent.request(acp.methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "Run echo" }]
        });
        expect(run.seen.terminals).toHaveLength(1);
        expect(run.seen.terminals[0]!.cwd).toBe(root);
        expect(run.seen.released).toEqual(["term-1"]);
        expect(run.seen.updates).toContainEqual(
            expect.objectContaining({ sessionUpdate: "tool_call_update", content: [{ type: "terminal", terminalId: "term-1" }] })
        );
        expect(JSON.stringify(run.prompts[1])).toContain("hello from the editor");
        run.connection.close();
    });

    it("switches mode and refuses one that does not exist", async () => {
        const run = connect([], null, NO_CAPS);
        const { session } = await run.start();
        await run.agent.request(acp.methods.agent.session.setMode, { sessionId: session.sessionId, modeId: "plan" });
        await expect(
            run.agent.request(acp.methods.agent.session.setMode, { sessionId: session.sessionId, modeId: "yolo" })
        ).rejects.toThrow();
        run.connection.close();
    });

    it("answers a prompt for an unknown session with an error", async () => {
        const run = connect([], null, NO_CAPS);
        await run.start();
        await expect(
            run.agent.request(acp.methods.agent.session.prompt, { sessionId: "nope", prompt: [{ type: "text", text: "x" }] })
        ).rejects.toThrow();
        run.connection.close();
    });

    it("cancels a turn that is waiting on the model", async () => {
        let release: () => void = () => undefined;
        const model = new MockLanguageModelV4({
            doGenerate: (options) =>
                new Promise((_, reject) => {
                    release = () => reject(new Error("aborted"));
                    options.abortSignal?.addEventListener("abort", () => reject(options.abortSignal?.reason));
                })
        });
        const wire = pipes();
        createAcpAgent({ model: () => model, modelName: "polar", newId: () => "s-1", rules: () => [], store: memoryStore() }).connect(wire.agentStream);
        const { app } = editor(null);
        const connection = app.connect(acp.ndJsonStream(wire.toAgent.writable, wire.toClient.readable));
        await connection.agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: NO_CAPS });
        await connection.agent.request(acp.methods.agent.session.new, { cwd: root, mcpServers: [] });
        const turn = connection.agent.request(acp.methods.agent.session.prompt, {
            sessionId: "s-1",
            prompt: [{ type: "text", text: "think forever" }]
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: "s-1" });
        const done = await turn;
        release();
        expect(done.stopReason).toBe("cancelled");
        connection.close();
    });

    it("drops a frame that is not a JSON-RPC envelope and answers the next", async () => {
        const wire = pipes();
        const { model } = scripted([]);
        createAcpAgent({ model: () => model, modelName: "polar", rules: () => [], store: memoryStore() }).connect(wire.agentStream);
        const writer = wire.toAgent.writable.getWriter();
        const encode = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
        const params = { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: NO_CAPS };
        await writer.write(encode({ jsonrpc: "2.0", id: 1, method: "initialize", params, smuggled: true }));
        await writer.write(encode({ jsonrpc: "1.0", id: 2, method: "initialize", params }));
        await writer.write(encode({ jsonrpc: "2.0", id: 3, method: "initialize", params }));
        const reader = wire.toClient.readable.getReader();
        let text = "";
        while (!text.includes("\n")) {
            const { value } = await reader.read();
            text += new TextDecoder().decode(value);
        }
        const answer = JSON.parse(text.split("\n")[0]!) as { id: number; result: { protocolVersion: number } };
        expect(answer.id).toBe(3);
        expect(answer.result.protocolVersion).toBe(acp.PROTOCOL_VERSION);
        expect(wire.dropped).toEqual(["initialize", "initialize"]);
    });
});

describe("loading a session", () => {
    it("replays the conversation, then continues it with the earlier turn in the model's input", async () => {
        const store = memoryStore();
        const file = path.join(root, "a.txt");
        await fs.writeFile(file, "on disk\n");
        const first = connect(
            [{ calls: [{ name: "Read", input: { file_path: file } }] }, { text: "First answer." }],
            null,
            NO_CAPS,
            undefined,
            store
        );
        const { session } = await first.start();
        await first.agent.request(acp.methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "Read a.txt" }]
        });
        first.connection.close();
        expect(store.files.get(session.sessionId)).toContain("First answer.");

        const second = connect([{ text: "Second answer." }], null, NO_CAPS, undefined, store);
        await second.agent.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: NO_CAPS
        });
        const loaded = await second.agent.request(acp.methods.agent.session.load, {
            sessionId: session.sessionId,
            cwd: root,
            mcpServers: []
        });
        expect(loaded?.modes?.currentModeId).toBe("default");
        // Replayed before the answer, in order.
        expect(second.seen.updates.map((update) => update.sessionUpdate)).toEqual([
            "user_message_chunk",
            "tool_call",
            "agent_message_chunk"
        ]);
        expect(second.seen.updates[0]).toEqual({
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "Read a.txt" }
        });
        expect(second.seen.updates[1]).toEqual(
            expect.objectContaining({ sessionUpdate: "tool_call", status: "completed", kind: "read", locations: [{ path: file }] })
        );
        expect(second.seen.updates[2]).toEqual({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "First answer." }
        });
        const done = await second.agent.request(acp.methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "And now?" }]
        });
        expect(done.stopReason).toBe("end_turn");
        const input = JSON.stringify(second.prompts[0]);
        expect(input).toContain("Read a.txt");
        expect(input).toContain("on disk");
        expect(input).toContain("First answer.");
        expect(input).toContain("And now?");
        second.connection.close();
    });

    it("answers sessionNotFound for an id it has no transcript for, or one that is not an id", async () => {
        const run = connect([], null, NO_CAPS);
        await run.start();
        for (const sessionId of ["s-404", "../../etc/passwd"]) {
            await expect(
                run.agent.request(acp.methods.agent.session.load, { sessionId, cwd: root, mcpServers: [] })
            ).rejects.toThrow();
        }
        run.connection.close();
    });

    it("says once that the editor's MCP servers are not mounted", async () => {
        const run = connect([{ text: "One." }, { text: "Two." }], null, NO_CAPS);
        await run.agent.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: NO_CAPS
        });
        const session = await run.agent.request(acp.methods.agent.session.new, {
            cwd: root,
            mcpServers: [{ name: "github", command: "github-mcp", args: [], env: [] }]
        });
        expect(run.seen.updates).toEqual([]);
        for (const text of ["first", "second"]) {
            await run.agent.request(acp.methods.agent.session.prompt, {
                sessionId: session.sessionId,
                prompt: [{ type: "text", text }]
            });
        }
        const notices = run.seen.updates.filter((update) => JSON.stringify(update).includes("MCP servers"));
        expect(notices).toHaveLength(1);
        expect(run.seen.updates[0]).toEqual(notices[0]);
        expect(JSON.stringify(notices[0])).toContain("github");
        run.connection.close();
    });
});

describe("pieces", () => {
    it("replays only the main conversation, and a failed call as failed", () => {
        const line = (record: unknown) => JSON.stringify(record);
        const text = [
            line({ type: "user", message: { content: [{ type: "text", text: "Hi" }] } }),
            line({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "subagent" }] } }),
            line({
                type: "assistant",
                message: {
                    content: [
                        { type: "text", text: "On it." },
                        { type: "tool_use", id: "t1", name: "Bash", input: { command: "false" } }
                    ]
                }
            }),
            line({
                type: "user",
                message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "exit 1", is_error: true }] }
            }),
            line({ type: "system", subtype: "compact_boundary", content: "Conversation compacted" }),
            line({ type: "user", isCompactSummary: true, message: { content: [{ type: "text", text: "summary" }] } }),
            line({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }),
            "not json"
        ].join("\n");
        expect(replayUpdates(text)).toEqual([
            { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Hi" } },
            { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "On it." } },
            {
                sessionUpdate: "tool_call",
                toolCallId: "t1",
                status: "completed",
                rawInput: { command: "false" },
                title: "Bash: false",
                kind: "execute"
            },
            {
                sessionUpdate: "tool_call_update",
                toolCallId: "t1",
                status: "failed",
                content: [{ type: "content", content: { type: "text", text: "exit 1" } }]
            }
        ]);
    });

    it("names the editor's MCP servers, bounded", () => {
        expect(mcpNotice([])).toBeNull();
        const many = Array.from({ length: 12 }, (_, index) => ({ name: `s${index}` }));
        expect(mcpNotice(many)).toContain("s9 and 2 more");
    });

    it("reads the environment and names what is missing, never its value", () => {
        expect(readAcpEnv({})).toEqual({ invalid: ["POLARIS_API_KEY", "POLARIS_URL"] });
        const read = readAcpEnv({ POLARIS_URL: "https://polaris.example.test/", POLARIS_API_KEY: "pk_test_0123456789abcdef" });
        expect(read).toEqual({
            config: { POLARIS_URL: "https://polaris.example.test", POLARIS_API_KEY: "pk_test_0123456789abcdef", POLARIS_MODEL: "polar" }
        });
        expect(acpEnvSchema.safeParse({ POLARIS_URL: "ftp://x.test", POLARIS_API_KEY: "pk_test_0123456789abcdef" }).success).toBe(false);
    });

    it("turns prompt blocks into one message", () => {
        expect(
            promptText([
                { type: "text", text: "Look at" },
                { type: "resource_link", uri: "file:///home/me/app/main.ts", name: "main.ts" },
                { type: "resource", resource: { uri: "file:///home/me/app/b.ts", text: "export {}" } },
                { type: "image", data: "", mimeType: "image/png" },
                { type: "bogus" }
            ])
        ).toBe('Look at\n\n@/home/me/app/main.ts\n\n<file path="/home/me/app/b.ts">\nexport {}\n</file>');
        expect(promptText([{ type: "resource_link", uri: "file:///C:/work/a.ts", name: "a.ts" }])).toBe("@C:/work/a.ts");
    });

    it("describes calls with a kind, a location and an edit's diff", () => {
        expect(describeCall("Edit", { file_path: "/a.ts", old_string: "x", new_string: "y" })).toEqual({
            title: "Edit: /a.ts",
            kind: "edit",
            locations: [{ path: "/a.ts" }],
            content: [{ type: "diff", path: "/a.ts", oldText: "x", newText: "y" }]
        });
        expect(describeCall("Bash", { command: "npm test\nmore" }).title).toBe("Bash: npm test");
        expect(describeCall("Mystery", {}).kind).toBe("other");
    });

    it("maps the option picked to the engine's decision", () => {
        const always = permissionDecision({ outcome: "selected", optionId: "allow_always" }, "Write");
        expect(JSON.stringify(always)).toContain("updatedPermissions");
        expect(JSON.stringify(permissionDecision({ outcome: "cancelled" }, "Write"))).toContain('"deny"');
        expect(JSON.stringify(permissionDecision(null, "Write"))).toContain('"deny"');
    });

    it("streams only the main conversation's assistant text", () => {
        const line = (record: unknown) => JSON.stringify(record);
        expect(assistantText(line({ type: "assistant", message: { content: [{ type: "text", text: "Hi" }, { type: "tool_use" }] } }))).toBe("Hi");
        expect(assistantText(line({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "Hi" }] } }))).toBe("");
        expect(assistantText(line({ type: "user", message: { content: [{ type: "text", text: "Hi" }] } }))).toBe("");
        expect(assistantText("not json")).toBe("");
    });

    it("says why Polaris refused the key", async () => {
        const config = { POLARIS_URL: "https://polaris.example.test", POLARIS_API_KEY: "pk_test_0123456789abcdef", POLARIS_MODEL: "polar" };
        const answering = (status: number) => (async () => new Response(null, { status })) as unknown as typeof fetch;
        await expect(checkAcpAccess(config, answering(204))).resolves.toBeUndefined();
        await expect(checkAcpAccess(config, answering(401))).rejects.toThrow(/did not accept/);
        await expect(checkAcpAccess(config, answering(403))).rejects.toThrow(/not allowed/);
        const offline = (async () => {
            throw new Error("ECONNREFUSED");
        }) as unknown as typeof fetch;
        await expect(checkAcpAccess(config, offline)).rejects.toThrow(/could not be reached/);
    });
});
