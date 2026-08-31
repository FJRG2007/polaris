/**
 * POST /api/mcp - Polaris as a tool server for coding agents.
 *
 * Point any MCP client at this URL with a Polaris API key and it gains the tools
 * in `lib/mcp/tools`: read the task it was given, move it on, comment on it,
 * start another session. That is the whole reason this exists - an agent working
 * on somebody's repository has to be able to reach the instance that asked it to,
 * and MCP is the one interface every coding agent already speaks.
 *
 * A key, not a session cookie. The caller is a process on a machine somewhere,
 * possibly not the operator's, and it should hold a credential that can be
 * scoped, listed and revoked on its own. Everything a tool may do is bounded by
 * that key's scopes intersected with what its owner holds right now, so a key
 * never outlives the permission behind it.
 *
 * Stateless: no session id, no stream to hold open, nothing to reap after a
 * client that went away. See `lib/mcp/protocol.ts` for why that is the right
 * trade here.
 */

import { prisma } from "@polaris/db";
import type { Permission } from "@polaris/core";
import { MCP_TOOLS } from "@/lib/mcp/tools";
import { authenticateApiKey } from "@/lib/api-key-auth";
import { sessionForToken, sessionOwner } from "@/lib/agents/session-service";
import {
    MCP_PROTOCOL_VERSION,
    RPC_INVALID_REQUEST,
    RPC_PARSE_ERROR,
    handleMcpMessage,
    type JsonRpcResponse,
    type McpCaller,
    type McpServerInfo
} from "@/lib/mcp/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the client is told it has connected to, and how to behave once it has.
 *
 * The instructions are read by the model, not by the client's author, so they say
 * the two things a model gets wrong here: that this Polaris is the source of
 * truth about the work rather than a place to file a report afterwards, and that
 * a status is moved by name.
 */
const SERVER: McpServerInfo = {
    name: "polaris",
    version: "1",
    instructions: [
        "Polaris is the control plane this work is being tracked in.",
        "If you were given a task, read it with tasks_get before starting, move it on with",
        "tasks_update as you go, and say what you found in tasks_comment when you finish -",
        "including anything you could not do. Statuses, spaces and lists are named the way",
        "the people using them named them, so pass the name rather than looking up an id.",
        "Work you find that is out of scope belongs in tasks_create, not in this change."
    ].join(" ")
};

function jsonRpcError(code: number, message: string, status: number): Response {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code, message } }, { status });
}

/**
 * What a running session may do with these tools.
 *
 * Enough to work the board it was pointed at, and not enough to start more
 * sessions: an agent that can start agents is one bad turn away from starting
 * them in a loop, on somebody else's hardware, with nobody watching. A person who
 * wants that hands over an API key, which is a decision rather than a default.
 */
const SESSION_SCOPES: Permission[] = ["tasks.read", "tasks.manage", "agents.read"];

/**
 * Resolve the caller from whatever they presented.
 *
 * Two credentials, and the second is what makes this usable at all. An API key is
 * a person deliberately connecting their own client. A session's reporting token
 * is the agent Polaris started, which was handed these tools in its own
 * configuration before it ran - so "connect your agent to Polaris" is not a setup
 * step anybody has to know about, and nothing has to be minted for it.
 */
async function callerFor(request: Request): Promise<McpCaller | null> {
    const principal = await authenticateApiKey(request);
    if (principal) {
        const user = await prisma.user.findUnique({
            where: { id: principal.userId },
            select: { isAdmin: true }
        });
        if (!user) return null;
        return { userId: principal.userId, isAdmin: user.isAdmin, scopes: principal.scopes };
    }

    const header = request.headers.get("authorization") ?? "";
    const [scheme, ...rest] = header.trim().split(/\s+/);
    if (scheme?.toLowerCase() !== "bearer") return null;
    const session = await sessionForToken(rest.join(""));
    if (!session) return null;
    const owner = await sessionOwner(session.id);
    if (!owner) return null;
    // Never an administrator, whoever started it. A session acts inside one
    // person's work; the instance-wide reach an admin has is not something an
    // agent should inherit by being started by one.
    return { userId: owner, isAdmin: false, scopes: SESSION_SCOPES };
}

export async function POST(request: Request): Promise<Response> {
    const caller = await callerFor(request);
    // A 401 here rather than a JSON-RPC error: the call never reached the
    // protocol, and an MCP client that sees a 401 knows to fix its credential
    // rather than reporting a tool failure to the model.
    if (!caller) return Response.json({ error: "Unauthorized" }, { status: 401 });

    let payload: unknown;
    try {
        payload = await request.json();
    } catch {
        return jsonRpcError(RPC_PARSE_ERROR, "That was not JSON", 400);
    }

    const headers = { "MCP-Protocol-Version": MCP_PROTOCOL_VERSION };

    // A batch is a JSON array. Every message in it is answered independently, and
    // the notifications among them contribute nothing to the reply - which is
    // what makes a batch of only notifications correctly answer with no body.
    if (Array.isArray(payload)) {
        if (payload.length === 0) return jsonRpcError(RPC_INVALID_REQUEST, "An empty batch asks nothing", 400);
        const answers: JsonRpcResponse[] = [];
        for (const message of payload) {
            const answer = await handleMcpMessage(message, MCP_TOOLS, caller, SERVER);
            if (answer) answers.push(answer);
        }
        if (answers.length === 0) return new Response(null, { status: 202, headers });
        return Response.json(answers, { headers });
    }

    const answer = await handleMcpMessage(payload, MCP_TOOLS, caller, SERVER);
    if (!answer) return new Response(null, { status: 202, headers });
    return Response.json(answer, { headers });
}

/**
 * A client opening the server-to-client stream.
 *
 * Refused, and refused in a way that says so. The transport allows a server not
 * to offer one, and nothing here needs it: these are tools that answer, not
 * subscriptions. A client that gets a 405 stops asking; one that gets a hanging
 * connection waits forever.
 */
export async function GET(): Promise<Response> {
    return Response.json(
        { error: "This MCP server answers requests, and has no stream to open. POST your JSON-RPC here." },
        { status: 405, headers: { Allow: "POST", "MCP-Protocol-Version": MCP_PROTOCOL_VERSION } }
    );
}
