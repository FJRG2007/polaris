/**
 * POST /api/terminal/relay - the WebSocket sidecar on this node asking about
 * the Polaris Terminal relay sockets it holds (`terminal-relay.mjs`).
 *
 * Loopback only, behind the internal key the sidecar already uses for its other
 * calls. Operations: check what a socket presented, record a terminal coming
 * online or leaving, say where a controller's request goes, carry a request or
 * its answer to another node, and name the held terminals whose key has ended.
 */

import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { originIp, originUserAgent } from "@polaris/core";
import {
    TERMINAL_BODY_BYTES,
    authenticateRelaySocket,
    endedTerminals,
    listenForTerminalCalls,
    recordTerminalPresence,
    routeTerminalRequest,
    sendRemoteCall
} from "@/lib/terminal/relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const node = z.string().min(1).max(255);
const reported = z.string().max(120).nullish();

const bodySchema = z.discriminatedUnion("op", [
    z.object({
        op: z.literal("auth"),
        token: z.string().min(1).max(512),
        role: z.enum(["instance", "controller"]),
        headers: z.record(z.string(), z.string().max(1024)).default({})
    }),
    z.object({
        op: z.literal("presence"),
        instanceId: z.string().uuid(),
        node,
        online: z.boolean(),
        name: reported,
        os: reported,
        version: reported
    }),
    z.object({
        op: z.literal("route"),
        userId: z.string().uuid(),
        keyId: z.string().uuid(),
        instanceId: z.string().uuid()
    }),
    z.object({
        op: z.literal("forward"),
        node,
        origin: node,
        id: z.string().uuid(),
        instanceId: z.string().uuid(),
        envelope: z.unknown()
    }),
    z.object({ op: z.literal("reply"), node, id: z.string().uuid(), frame: z.unknown() }),
    z.object({ op: z.literal("standing"), instanceIds: z.array(z.string().uuid()).max(10_000) })
]);

function safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function POST(request: Request): Promise<Response> {
    const secret = process.env.POLARIS_AUTH_SECRET ?? "";
    if (!secret || !safeEqual(request.headers.get("x-internal-key") ?? "", secret))
        return Response.json({ error: "forbidden" }, { status: 403 });
    const raw = await request.text();
    // i18n-ignore read by a machine, not shown to a person
    if (raw.length > TERMINAL_BODY_BYTES) return Response.json({ error: "too large" }, { status: 413 });
    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch {
        json = null;
    }
    const parsed = bodySchema.safeParse(json);
    // i18n-ignore read by a machine, not shown to a person
    if (!parsed.success) return Response.json({ error: "invalid body" }, { status: 400 });
    const body = parsed.data;

    switch (body.op) {
        case "auth": {
            const origin = new Headers(body.headers);
            const identity = await authenticateRelaySocket({
                token: body.token,
                role: body.role,
                ip: originIp(origin),
                userAgent: originUserAgent(origin)
            });
            if (identity?.instanceId) listenForTerminalCalls();
            return Response.json(identity);
        }
        case "presence":
            if (body.online) listenForTerminalCalls();
            await recordTerminalPresence(body);
            return Response.json({ ok: true });
        case "route":
            listenForTerminalCalls();
            return Response.json(await routeTerminalRequest(body));
        case "forward":
            return Response.json({
                ok: await sendRemoteCall(body.node, {
                    path: "/terminal/deliver",
                    body: { instanceId: body.instanceId, id: body.id, origin: body.origin, envelope: body.envelope }
                })
            });
        case "reply":
            return Response.json({
                ok: await sendRemoteCall(body.node, { path: "/terminal/reply", body: { id: body.id, frame: body.frame } })
            });
        case "standing":
            return Response.json({ ended: await endedTerminals(body.instanceIds) });
    }
}
