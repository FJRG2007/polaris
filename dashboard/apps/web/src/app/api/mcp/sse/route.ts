/**
 * GET/POST /api/mcp/sse - the MCP server over the legacy HTTP+SSE transport.
 *
 * For clients that only speak the 2024-11-05 transport: GET opens an event
 * stream that first names the address to POST to (`/api/mcp/sse?sessionId=`),
 * and every reply to those POSTs arrives on that stream. Clients that speak
 * Streamable HTTP use `/api/mcp` and never come here.
 *
 * Nothing about who may call what is decided here. Every request is answered by
 * the `/api/mcp` handler itself - the GET is admitted by a ping through it, and
 * each POST is handed to it whole - so credentials, OAuth audience, the
 * account's network rules, scopes, rate limits and the audit log are the ones
 * the streamable endpoint applies, from the same code. What this adds is the
 * session: a POST is accepted only from the credential that opened its stream.
 *
 * Same host and path prefix as the dashboard, so the edge routes it with the
 * dashboard's own routers and needs no router of its own.
 */

import { z } from "zod";
import * as streamable from "@/app/api/mcp/route";
import { originOf } from "@/lib/mcp/oauth/origin";
import { mcpResource } from "@/lib/mcp/oauth/urls";
import { rateLimit } from "@/lib/rate-limit-service";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { ACCESS_TOKEN_PREFIX, verifyAccessToken } from "@/lib/mcp/oauth/grants";
import { bearerToken, deliver, openSession, ownerKey, ownsSession } from "@/lib/mcp/sse-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Streams one credential may open a minute. */
const OPENS_PER_MINUTE = 30;

const sessionIdSchema = z.string().uuid();

function refusal(status: number, error: string, headers: HeadersInit = {}): Response {
    return Response.json({ error }, { status, headers });
}

/**
 * Ask the streamable handler whether this request's credential may call it,
 * with a ping that changes nothing and spends no tool budget. Its answer is
 * returned as it is, so a refused client gets the same 401 and the same
 * `WWW-Authenticate` challenge that starts the OAuth flow.
 */
async function admit(request: Request): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    headers.set("content-type", "application/json");
    return streamable.POST(
        new Request(request.url, {
            method: "POST",
            headers,
            body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" })
        })
    );
}

/** The session owner the request's credential names, or null when it names
 *  none (no bearer, or an access token that is expired or not for here). */
async function ownerOf(request: Request): Promise<string | null> {
    const token = bearerToken(request.headers.get("authorization"));
    if (!token) return null;
    if (!token.startsWith(ACCESS_TOKEN_PREFIX)) return ownerKey(token, null);
    const access = await verifyAccessToken(token, mcpResource(originOf(request)));
    return access ? ownerKey(token, access.grantId) : null;
}

/** Open the event stream. */
export async function GET(request: Request): Promise<Response> {
    const admitted = await admit(request);
    if (admitted.status !== 200) return admitted;
    const owner = await ownerOf(request);
    // i18n-ignore read by a machine, not shown to a person
    if (!owner) return refusal(401, "Unauthorized");

    const throttle = await rateLimit(`mcp-sse-open:${owner}`, OPENS_PER_MINUTE, 60_000);
    if (!throttle.ok) {
        const wait = Math.max(1, Math.ceil(throttle.retryAfterMs / 1000));
        // i18n-ignore read by a machine, not shown to a person
        return refusal(429, `Too many streams opened. Try again in ${wait}s.`, {
            "Retry-After": String(wait)
        });
    }

    const opened = await openSession(owner, request.signal);
    if (opened === "credential-full")
        // i18n-ignore read by a machine, not shown to a person
        return refusal(
            429,
            "This credential already holds the most open streams. Close one first."
        );
    if (opened === "instance-full")
        // i18n-ignore read by a machine, not shown to a person
        return refusal(503, "Too many open streams on this server. Try again shortly.", {
            "Retry-After": "30"
        });

    return new Response(opened.body, {
        headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-store, no-transform",
            connection: "keep-alive",
            // Tells nginx-style proxies not to buffer the stream.
            "x-accel-buffering": "no"
        }
    });
}

/**
 * A message for an open stream. Answered 202 once its reply is on the stream,
 * and 410 when the message was handled but its stream closed before the reply
 * could be put on it, so a client does not run it again; a refusal before the protocol (401, 413, a malformed body) is answered here
 * exactly as `/api/mcp` answers it.
 */
export async function POST(request: Request): Promise<Response> {
    const owner = await ownerOf(request);
    if (!owner) {
        const admitted = await admit(request);
        // i18n-ignore read by a machine, not shown to a person
        return admitted.status === 200 ? refusal(401, "Unauthorized") : admitted;
    }

    // An unknown session and somebody else's are the same answer, so a session
    // id is worth nothing to anyone but the credential that opened it.
    const sessionId = sessionIdSchema.safeParse(new URL(request.url).searchParams.get("sessionId"));
    if (!sessionId.success || !ownsSession(sessionId.data, owner))
        // i18n-ignore read by a machine, not shown to a person
        return refusal(404, "No open stream for this session. Open one with GET first.");

    const answered = await streamable.POST(request);
    if (answered.status === 202) return new Response(null, { status: 202 });
    if (answered.status !== 200) return answered;

    const reply = (await answered.json()) as JSONRPCMessage | JSONRPCMessage[];
    const delivered = await deliver(sessionId.data, Array.isArray(reply) ? reply : [reply]);
    if (!delivered)
        // i18n-ignore read by a machine, not shown to a person
        return refusal(
            410,
            "This message was handled, but its stream closed before the reply could be sent."
        );
    return new Response(null, { status: 202 });
}
