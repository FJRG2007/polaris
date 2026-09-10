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

import { z } from "zod";
import { prisma } from "@polaris/db";
import { MCP_TOOLS } from "@/lib/mcp/tools";
import { readCappedBody } from "@/lib/request-body";
import type { Permission } from "@polaris/core";
import { DEPLOY_TOOLS } from "@/lib/mcp/tools/deploy";
import { authenticateApiKey } from "@/lib/api-key-auth";
import { throttleDeployKey, tooManyCalls } from "@/lib/deploy/api/http";
import { sessionForToken, sessionOwner } from "@/lib/agents/session-service";
import {
    MCP_PROTOCOL_VERSION,
    RPC_INVALID_REQUEST,
    RPC_PARSE_ERROR,
    handleMcpMessage,
    toolFailure,
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
        "Work you find that is out of scope belongs in tasks_create, not in this change.",
        "The deploy_ tools name a service as project/service or project/environment/service;",
        "deploy_projects lists them. After deploy_start, read deploy_deployment until it finishes",
        "and report a failure with the lines that explain it."
    ].join(" ")
};

function jsonRpcError(code: number, message: string, status: number): Response {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code, message } }, { status });
}

/** How many messages one request may carry. JSON-RPC puts no limit on a batch,
 *  and an unbounded one is a way to make a single request do a thousand tool
 *  calls - each of which reaches the database and, for some of them, somebody
 *  else's tracker. */
const BATCH_MAX = 20;

/** The most one request may carry: a full batch of the largest arguments any
 *  tool takes, with room to spare. Read no further, so a body is refused for its
 *  size before it is held. */
const BODY_MAX = 4 * 1024 * 1024;

/**
 * The envelope, before anything looks at what is inside it.
 *
 * One message or a batch of them, and nothing else: a body that is a string, a
 * number or null is refused here rather than reaching the handler, which would
 * have had to answer for it one message at a time. What each message IS stays the
 * handler's business - it owns the JSON-RPC shape and the version negotiation -
 * so this checks the container and its size and stops.
 */
const envelopeSchema = z.union([
    z.record(z.unknown()),
    z.array(z.record(z.unknown())).min(1, "An empty batch asks nothing").max(BATCH_MAX)
]);

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
        return {
            userId: principal.userId,
            isAdmin: user.isAdmin,
            scopes: principal.scopes,
            keyId: principal.keyId,
            projectId: principal.projectId
        };
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

/**
 * Spend a deploy tool call against the key's Deploy API budgets, the same ones a
 * REST call spends. Counted per call rather than per request, so a batch of
 * twenty deploy_start calls costs what twenty deploys through the API cost and
 * is held back where they would be. Answers the reply for a call over budget,
 * or null for one that may run - including every message that is not a deploy
 * tool call, which the handler answers as it always has.
 */
async function overBudget(
    message: Record<string, unknown>,
    caller: McpCaller
): Promise<JsonRpcResponse | null> {
    if (!caller.keyId || message.method !== "tools/call") return null;
    const id = message.id;
    // A notification is answered with nothing and runs nothing, and a malformed
    // id is the handler's to refuse.
    if (typeof id !== "string" && typeof id !== "number" && id !== null) return null;
    const name = (message.params as { name?: unknown } | undefined)?.name;
    const tool = DEPLOY_TOOLS.find((candidate) => candidate.name === name);
    if (!tool) return null;
    const wait = await throttleDeployKey(caller.keyId, !tool.readOnly);
    return wait === null ? null : toolFailure(id, tooManyCalls(wait));
}

/** One message, answered after its deploy budget is spent. */
async function answer(
    message: Record<string, unknown>,
    caller: McpCaller
): Promise<JsonRpcResponse | null> {
    return (await overBudget(message, caller)) ?? handleMcpMessage(message, MCP_TOOLS, caller, SERVER);
}

export async function POST(request: Request): Promise<Response> {
    const caller = await callerFor(request);
    // A 401 here rather than a JSON-RPC error: the call never reached the
    // protocol, and an MCP client that sees a 401 knows to fix its credential
    // rather than reporting a tool failure to the model.
    if (!caller) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const tooLarge = () => jsonRpcError(RPC_INVALID_REQUEST, `A request is at most ${BODY_MAX / 1024 ** 2} MB`, 413);
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > BODY_MAX) return tooLarge();
    const bytes = await readCappedBody(request, BODY_MAX);
    if (!bytes) return tooLarge();

    let body: unknown;
    try {
        body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
        return jsonRpcError(RPC_PARSE_ERROR, "That was not JSON", 400);
    }

    const envelope = envelopeSchema.safeParse(body);
    if (!envelope.success) {
        const said = envelope.error.issues[0]?.message ?? "That is not a JSON-RPC request";
        return jsonRpcError(RPC_INVALID_REQUEST, said, 400);
    }
    const payload = envelope.data;

    const headers = { "MCP-Protocol-Version": MCP_PROTOCOL_VERSION };

    // A batch is a JSON array. Every message in it is answered independently, and
    // the notifications among them contribute nothing to the reply - which is
    // what makes a batch of only notifications correctly answer with no body.
    if (Array.isArray(payload)) {
        const answers: JsonRpcResponse[] = [];
        for (const message of payload) {
            const reply = await answer(message, caller);
            if (reply) answers.push(reply);
        }
        if (answers.length === 0) return new Response(null, { status: 202, headers });
        return Response.json(answers, { headers });
    }

    const reply = await answer(payload, caller);
    if (!reply) return new Response(null, { status: 202, headers });
    return Response.json(reply, { headers });
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
        {
            error: "This MCP server answers requests, and has no stream to open. POST your JSON-RPC here."
        },
        { status: 405, headers: { Allow: "POST", "MCP-Protocol-Version": MCP_PROTOCOL_VERSION } }
    );
}
