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
 * Or an OAuth access token, which is how an assistant that cannot be handed a
 * key connects (Claude, ChatGPT, editors that sign in themselves): a call with
 * no credential is answered 401 with a pointer to the resource metadata, the
 * assistant sends its person through the consent screen, and comes back with a
 * token bound to this endpoint. See `lib/mcp/oauth`.
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
import { clientIp } from "@/lib/request-context";
import { recordAudit } from "@/lib/audit-service";
import { rateLimit } from "@/lib/rate-limit-service";
import { mcpScopes } from "@/lib/mcp/oauth/scopes";
import { originOf } from "@/lib/mcp/oauth/origin";
import { evaluateAccountAccess } from "@/lib/network-rules";
import { mcpResource, wwwAuthenticate } from "@/lib/mcp/oauth/urls";
import { ACCESS_TOKEN_PREFIX, touchGrant, verifyAccessToken } from "@/lib/mcp/oauth/grants";
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

/** A connected app carries no address rules of its own; its person's still
 *  apply, through `evaluateAccountAccess`. */
const NO_RULES_OF_ITS_OWN = { allowedCidrs: [], allowedCountries: [], allowedContinents: [] };

/**
 * Resolve the caller from whatever they presented.
 *
 * Three credentials. An OAuth access token is an assistant its person connected
 * through the consent screen. Of the other two, the second is what makes this
 * usable for agents at all. An API key is
 * a person deliberately connecting their own client. A session's reporting token
 * is the agent Polaris started, which was handed these tools in its own
 * configuration before it ran - so "connect your agent to Polaris" is not a setup
 * step anybody has to know about, and nothing has to be minted for it.
 */
async function callerFor(request: Request): Promise<McpCaller | null> {
    const header = request.headers.get("authorization") ?? "";
    const [scheme, ...rest] = header.trim().split(/\s+/);
    if (scheme?.toLowerCase() !== "bearer") return null;
    const token = rest.join("");

    // An app somebody connected through the consent screen. Its token is good
    // for this endpoint at the address it was issued for and nowhere else, and
    // the account's network rules apply to it exactly as to a key.
    if (token.startsWith(ACCESS_TOKEN_PREFIX)) {
        const access = await verifyAccessToken(token, mcpResource(originOf(request)));
        if (!access) return null;
        const ip = await clientIp();
        const decision = await evaluateAccountAccess(access.userId, ip, NO_RULES_OF_ITS_OWN);
        if (!decision.allowed) return null;
        await touchGrant(access.grantId, ip);
        return {
            userId: access.userId,
            isAdmin: access.isAdmin,
            scopes: access.scopes,
            grantId: access.grantId
        };
    }

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

    const session = await sessionForToken(token);
    if (!session) return null;
    const owner = await sessionOwner(session.id);
    if (!owner) return null;
    // Never an administrator, whoever started it. A session acts inside one
    // person's work; the instance-wide reach an admin has is not something an
    // agent should inherit by being started by one.
    return { userId: owner, isAdmin: false, scopes: SESSION_SCOPES, sessionId: session.id };
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
    if (message.method !== "tools/call") return null;
    const id = message.id;
    // A notification is answered with nothing and runs nothing, and a malformed
    // id is the handler's to refuse.
    if (typeof id !== "string" && typeof id !== "number" && id !== null) return null;
    const name = (message.params as { name?: unknown } | undefined)?.name;
    const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
    if (!tool) return null;

    // Every tool, for every credential: a model in a loop is the ordinary way
    // this gets called far too often, and each call reaches the database.
    const credential =
        caller.keyId ??
        caller.grantId ??
        (caller.sessionId ? `session:${caller.sessionId}` : `user:${caller.userId}`);
    for (const [bucket, limit] of [
        [`mcp-call:${credential}`, CALLS_PER_MINUTE],
        ...(tool.readOnly ? [] : [[`mcp-change:${credential}`, CHANGES_PER_MINUTE] as const])
    ] as const) {
        const throttle = await rateLimit(bucket, limit, 60_000);
        if (!throttle.ok)
            return toolFailure(
                id,
                tooManyCalls(Math.max(1, Math.ceil(throttle.retryAfterMs / 1000)))
            );
    }

    // And the deploy tools spend the Deploy API's own budgets on top, keyed the
    // same way a REST call with this credential would be.
    const deployKey = caller.keyId ?? caller.grantId;
    if (!deployKey || !DEPLOY_TOOLS.some((candidate) => candidate.name === name)) return null;
    const wait = await throttleDeployKey(deployKey, !tool.readOnly);
    return wait === null ? null : toolFailure(id, tooManyCalls(wait));
}

/** How many tool calls one credential may make a minute, and how many of them
 *  may change something. Generous for an assistant working a task, and well
 *  short of what a runaway loop would make. */
const CALLS_PER_MINUTE = 120;
const CHANGES_PER_MINUTE = 30;

/**
 * Write a tool call that changed something to the person's activity, saying
 * which credential made it. Centrally rather than per tool, so a tool added
 * later cannot forget to - and only for calls that went through, since a
 * refusal changed nothing.
 */
async function auditChange(
    message: Record<string, unknown>,
    reply: JsonRpcResponse | null,
    caller: McpCaller
): Promise<void> {
    if (message.method !== "tools/call" || !reply || reply.error) return;
    const name = (message.params as { name?: unknown } | undefined)?.name;
    const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
    if (!tool || tool.readOnly) return;
    if ((reply.result as { isError?: boolean } | undefined)?.isError) return;
    await recordAudit({
        actorId: caller.userId,
        action: "mcp.tool.called",
        targetType: "mcpTool",
        metadata: {
            tool: tool.name,
            via: caller.grantId ? "oauth" : caller.keyId ? "api-key" : "agent-session",
            ...(caller.grantId ? { grantId: caller.grantId } : {}),
            ...(caller.keyId ? { keyId: caller.keyId } : {})
        }
    });
}

/** One message, answered after its budgets are spent, and audited if it
 *  changed something. */
async function answer(
    message: Record<string, unknown>,
    caller: McpCaller
): Promise<JsonRpcResponse | null> {
    const refused = await overBudget(message, caller);
    if (refused) return refused;
    const reply = await handleMcpMessage(message, MCP_TOOLS, caller, SERVER);
    await auditChange(message, reply, caller);
    return reply;
}

/** What tells a client how to get a credential: a 401 that points at the
 *  resource metadata (RFC 9728 section 5.1), which is where an assistant
 *  starts the OAuth flow. Clients holding an API key never see it. */
function unauthorized(request: Request, hadToken: boolean): Response {
    const origin = originOf(request);
    return Response.json(
        // i18n-ignore read by a machine, not shown to a person
        { error: "Unauthorized" },
        {
            status: 401,
            headers: { "WWW-Authenticate": wwwAuthenticate(origin, mcpScopes(), hadToken) }
        }
    );
}

export async function POST(request: Request): Promise<Response> {
    const caller = await callerFor(request);
    // A 401 here rather than a JSON-RPC error: the call never reached the
    // protocol, and an MCP client that sees a 401 knows to fix its credential
    // rather than reporting a tool failure to the model.
    // It carries the challenge that tells an assistant where to sign in.
    if (!caller)
        return unauthorized(
            request,
            /^bearer\s+\S/i.test(request.headers.get("authorization") ?? "")
        );

    const tooLarge = () =>
        jsonRpcError(RPC_INVALID_REQUEST, `A request is at most ${BODY_MAX / 1024 ** 2} MB`, 413);
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
            // i18n-ignore read by a machine, not shown to a person
            error: "This MCP server answers requests, and has no stream to open. POST your JSON-RPC here."
        },
        { status: 405, headers: { Allow: "POST", "MCP-Protocol-Version": MCP_PROTOCOL_VERSION } }
    );
}
