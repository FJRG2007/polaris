// A stand-in for `codex app-server` on stdio, for the app-server driver tests.
//
// It speaks the wire Codex documents (learn.chatgpt.com/docs/app-server):
// JSON-RPC 2.0 one message per line with the "jsonrpc" header left off, the
// `initialize` / `initialized` handshake, `thread/start` and `thread/resume`,
// `turn/start` streaming `item/*` notifications until `turn/completed`, and
// `turn/interrupt`. Every frame shape is the docs' own example, with ids
// changed. Every frame it receives is echoed to stderr as one JSON line, so a
// test can assert what the client sent.
//
// What a turn does depends on its text:
//   "run tests"  - asks to run a command (an approval), then answers
//   "hold"       - waits for `turn/interrupt`, then ends interrupted
//   "break"      - ends failed
//   anything else - answers at once
// Before the approval it also asks something Polaris does not model
// (`item/tool/requestUserInput`), which must be answered with an error.

import { createInterface } from "node:readline";

const THREAD = process.env.FAKE_THREAD ?? "thr_123";
let initialized = false;
let turns = 0;
let serverIds = 0;
const waiting = new Map();
let holding = null;

function send(frame) {
    process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function ask(method, params) {
    const id = `srv-${++serverIds}`;
    send({ id, method, params });
    return new Promise((resolve) => waiting.set(id, resolve));
}

async function runTurn(turnId, text) {
    const base = { threadId: THREAD, turnId };
    send({ method: "turn/started", params: { threadId: THREAD, turn: { id: turnId, items: [], status: "inProgress" } } });
    const user = { type: "userMessage", id: `${turnId}-u`, content: [{ type: "text", text }] };
    send({ method: "item/started", params: { ...base, item: user } });
    send({ method: "item/completed", params: { ...base, item: user } });
    if (text === "break") {
        send({ method: "error", params: { ...base, willRetry: false, error: { message: "usage limit" } } });
        send({
            method: "turn/completed",
            params: { threadId: THREAD, turn: { id: turnId, items: [], status: "failed", error: { message: "usage limit" } } }
        });
        return;
    }
    if (text === "hold") {
        await new Promise((resolve) => (holding = resolve));
        send({ method: "turn/completed", params: { threadId: THREAD, turn: { id: turnId, items: [], status: "interrupted" } } });
        return;
    }
    if (text === "run tests") {
        const input = await ask("item/tool/requestUserInput", { ...base, itemId: "q1", questions: [], autoResolutionMs: null });
        process.stderr.write(`${JSON.stringify({ answered: "item/tool/requestUserInput", reply: input })}\n`);
        const command = {
            type: "commandExecution",
            id: "cmd-1",
            command: "npm test",
            cwd: "/work",
            status: "inProgress",
            commandActions: []
        };
        send({ method: "item/started", params: { ...base, item: command } });
        const reply = await ask("item/commandExecution/requestApproval", {
            ...base,
            itemId: "cmd-1",
            reason: "Run the test suite",
            command: "npm test",
            cwd: "/work"
        });
        const decision = reply.result?.decision;
        const accepted = decision === "accept" || decision === "acceptForSession";
        send({ method: "serverRequest/resolved", params: { threadId: THREAD, requestId: "srv-2" } });
        send({
            method: "item/completed",
            params: {
                ...base,
                item: {
                    ...command,
                    status: accepted ? "completed" : "declined",
                    aggregatedOutput: accepted ? "42 passed" : null,
                    exitCode: accepted ? 0 : null
                }
            }
        });
    }
    const message = { type: "agentMessage", id: `${turnId}-a`, text: "" };
    send({ method: "item/started", params: { ...base, item: message } });
    send({ method: "item/agentMessage/delta", params: { ...base, itemId: message.id, delta: "All " } });
    send({ method: "item/agentMessage/delta", params: { ...base, itemId: message.id, delta: "done." } });
    // One frame with the header, which a reader must take as well.
    send({ jsonrpc: "2.0", method: "item/completed", params: { ...base, item: { ...message, text: "All done." } } });
    send({ method: "turn/completed", params: { threadId: THREAD, turn: { id: turnId, items: [], status: "completed" } } });
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
    if (!line.trim()) return;
    const frame = JSON.parse(line);
    process.stderr.write(`${line}\n`);
    if (frame.id !== undefined && frame.method === undefined) {
        const resolve = waiting.get(frame.id);
        waiting.delete(frame.id);
        resolve?.(frame);
        return;
    }
    const reply = (result) => send({ id: frame.id, result });
    const fail = (code, message) => send({ id: frame.id, error: { code, message } });
    switch (frame.method) {
        case "initialize":
            if (initialized) return fail(-32600, "Already initialized");
            initialized = true;
            return reply({ userAgent: "codex_cli_rs/0.0.0 (fake)", platformFamily: "unix", platformOs: "linux" });
        case "initialized":
            return;
        case "thread/start":
            if (!initialized) return fail(-32600, "Not initialized");
            reply({ thread: { id: THREAD, sessionId: THREAD, preview: "", ephemeral: false, modelProvider: "openai", createdAt: 1730910000 } });
            return send({ method: "thread/started", params: { thread: { id: THREAD } } });
        case "thread/resume":
            if (frame.params?.threadId !== THREAD) return fail(-32600, "thread not found");
            return reply({ thread: { id: THREAD, name: "Bug bash notes", ephemeral: false } });
        case "turn/start": {
            const turnId = `turn_${++turns}`;
            reply({ turn: { id: turnId, status: "inProgress", items: [], error: null } });
            const text = frame.params?.input?.[0]?.text ?? "";
            void runTurn(turnId, text);
            return;
        }
        case "turn/interrupt":
            reply({});
            holding?.();
            holding = null;
            return;
        default:
            return fail(-32601, "Method not found");
    }
});
lines.on("close", () => process.exit(0));
