/**
 * The tool server a CLI agent's session is given for the person's custom
 * tools: a stdio MCP server, Node's standard library only, written to the
 * session's state folder at boot (`asFile()` in session-runtime, decoded by
 * the boot script) and registered beside Polaris's own server in
 * `mcpConfig()` as `polaris-tools`.
 *
 * It holds no tool itself. `tools/list` and `tools/call` go to
 * `/api/agents/sessions/:id/tools` with the session's token, which answers
 * the list, or for a call the checked command (after the person's yes, when
 * the tool asks); the server runs that command here, in the sandbox, and
 * hands back its output. Newline-delimited JSON-RPC, as MCP's stdio
 * transport specifies.
 */

import { EXIT_MARK, OUTPUT_MAX } from "@/lib/polar/custom-tools/shared";

/** The server's name in the agent's MCP configuration. */
export const TOOLS_SERVER_NAME = "polaris-tools";

/** The file it is written to, inside the session's state folder. */
export const TOOLS_SERVER_FILE = "tools-mcp.mjs";

/** Stands for the session's state folder in the registration, replaced by
 *  the boot script: on a server that folder is under `$HOME`, which the
 *  agent would not expand in an MCP configuration. */
export const STATE_DIR_MARK = "@POLARIS_STATE_DIR@";

/** Left in the state folder when the boot found no `node` to run the server
 *  with, so the tools were not registered; the tools screen says so. */
export const TOOLS_NO_NODE_FILE = "tools-no-node";

/** MCP's revision this server speaks when the client names none it knows. */
const PROTOCOL_VERSION = "2025-06-18";

export function toolsMcpScript(): string {
    return `import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const URL_BASE = process.env.POLARIS_TOOLS_URL || "";
const TOKEN = process.env.POLARIS_TOOLS_TOKEN || "";
const EXIT_MARK = ${JSON.stringify(EXIT_MARK)};
const OUTPUT_MAX = ${OUTPUT_MAX};
const KNOWN = ["2024-11-05", "2025-03-26", "2025-06-18"];

function send(message) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
}

async function polaris(method, body) {
    const response = await fetch(URL_BASE, {
        method,
        headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {})
    });
    const answer = await response.json().catch(() => ({}));
    if (!response.ok && !answer.refusal) answer.refusal = "Polaris answered " + response.status + ".";
    return answer;
}

function run(command, seconds) {
    return new Promise((resolve) => {
        const child = spawn("sh", ["-c", command], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let output = "";
        const keep = (chunk) => {
            output = (output + chunk.toString("utf8")).slice(-(OUTPUT_MAX * 2));
        };
        child.stdout.on("data", keep);
        child.stderr.on("data", keep);
        const guard = setTimeout(() => child.kill("SIGKILL"), (seconds + 30) * 1000);
        child.on("error", () => resolve({ ok: false, text: "The tool could not be started in this session." }));
        child.on("close", () => {
            clearTimeout(guard);
            const at = output.lastIndexOf(EXIT_MARK);
            if (at < 0) return resolve({ ok: false, text: output.slice(-OUTPUT_MAX) || "The tool stopped before it finished." });
            const code = Number.parseInt(output.slice(at + EXIT_MARK.length).trim(), 10);
            const text = output.slice(0, at).replace(/\\n$/, "");
            if (code === 124) return resolve({ ok: false, text: "Ran past " + seconds + " s and was stopped.\\n" + text });
            resolve({ ok: code === 0, text: text || (code === 0 ? "(no output)" : "Exited with " + code + ".") });
        });
    });
}

async function handle(request) {
    const { id, method, params } = request;
    if (method === "initialize") {
        const asked = params && params.protocolVersion;
        return send({
            id,
            result: {
                protocolVersion: KNOWN.includes(asked) ? asked : ${JSON.stringify(PROTOCOL_VERSION)},
                capabilities: { tools: {} },
                serverInfo: { name: ${JSON.stringify(TOOLS_SERVER_NAME)}, version: "1.0.0" }
            }
        });
    }
    if (method === "ping") return send({ id, result: {} });
    if (method === "tools/list") {
        const answer = await polaris("GET").catch(() => ({ ok: false }));
        return send({ id, result: { tools: answer.ok && Array.isArray(answer.tools) ? answer.tools : [] } });
    }
    if (method === "tools/call") {
        const name = params && params.name;
        const prepared = await polaris("POST", { name, arguments: (params && params.arguments) || {} }).catch(() => ({
            ok: false,
            refusal: "Polaris could not be reached."
        }));
        if (!prepared.ok) return send({ id, result: { content: [{ type: "text", text: String(prepared.refusal || "Refused.") }], isError: true } });
        const outcome = await run(String(prepared.command), Number(prepared.timeoutSeconds) || 60);
        return send({ id, result: { content: [{ type: "text", text: outcome.text }], isError: !outcome.ok } });
    }
    if (id !== undefined) send({ id, error: { code: -32601, message: "Method not found" } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
    if (!line.trim()) return;
    let request;
    try {
        request = JSON.parse(line);
    } catch {
        return send({ id: null, error: { code: -32700, message: "Parse error" } });
    }
    handle(request).catch(() => {
        if (request.id !== undefined) send({ id: request.id, error: { code: -32603, message: "Internal error" } });
    });
});
`;
}
