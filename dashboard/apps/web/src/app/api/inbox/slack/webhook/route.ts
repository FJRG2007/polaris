/**
 * Slack Events API webhook. Handles the url_verification handshake, verifies every
 * request with the signing secret (v0 HMAC over the raw body + timestamp), and
 * ingests message events (JSON) and interactive button clicks (form-encoded),
 * mapping each to its channel by the Slack workspace (team) id.
 */

import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { findChannelByExternalId, ingestInbound } from "@/lib/messaging-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SIGNING_SECRET = process.env.MESSAGING_SLACK_SIGNING_SECRET ?? "";

function verify(raw: string, timestamp: string | null, signature: string | null): boolean {
    if (!SIGNING_SECRET || !timestamp || !signature) return false;
    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > 300) return false;
    const expected = `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${timestamp}:${raw}`).digest("hex")}`;
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
}

interface SlackEventBody {
    type?: string;
    challenge?: string;
    team_id?: string;
    event?: { type?: string; channel?: string; user?: string; text?: string; ts?: string; bot_id?: string; subtype?: string };
}

interface SlackInteractive {
    type?: string;
    team?: { id?: string };
    channel?: { id?: string };
    user?: { id?: string; username?: string };
    actions?: { action_id?: string; value?: string }[];
}

export async function POST(request: Request): Promise<Response> {
    const raw = await request.text();
    const timestamp = request.headers.get("x-slack-request-timestamp");
    const signature = request.headers.get("x-slack-signature");
    const contentType = request.headers.get("content-type") ?? "";

    if (contentType.includes("application/json")) {
        let body: SlackEventBody;
        try {
            body = JSON.parse(raw) as SlackEventBody;
        } catch {
            return NextResponse.json({ error: "Malformed payload" }, { status: 400 });
        }
        // The setup handshake is not signed.
        if (body.type === "url_verification") {
            return new Response(String(body.challenge ?? ""), { status: 200, headers: { "content-type": "text/plain" } });
        }
        if (!verify(raw, timestamp, signature)) {
            return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
        }
        const event = body.event;
        if (body.type === "event_callback" && event?.type === "message" && !event.bot_id && !event.subtype && body.team_id) {
            const channelId = await findChannelByExternalId("slack", body.team_id);
            if (channelId && event.channel) {
                await ingestInbound({
                    channelId,
                    peerId: event.channel,
                    peerName: event.user,
                    externalId: event.ts,
                    kind: "text",
                    body: event.text,
                    at: Date.now()
                });
            }
        }
        return NextResponse.json({ ok: true });
    }

    if (!verify(raw, timestamp, signature)) {
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
    const payloadRaw = new URLSearchParams(raw).get("payload");
    if (payloadRaw) {
        try {
            const payload = JSON.parse(payloadRaw) as SlackInteractive;
            if (payload.type === "block_actions" && payload.team?.id) {
                const channelId = await findChannelByExternalId("slack", payload.team.id);
                const action = payload.actions?.[0];
                if (channelId && action) {
                    await ingestInbound({
                        channelId,
                        peerId: payload.channel?.id ?? "",
                        peerName: payload.user?.username ?? payload.user?.id,
                        kind: "interactive",
                        selection: action.action_id ?? action.value,
                        at: Date.now()
                    });
                }
            }
        } catch {
            // Ignore a malformed interactive payload.
        }
    }
    return NextResponse.json({ ok: true });
}
