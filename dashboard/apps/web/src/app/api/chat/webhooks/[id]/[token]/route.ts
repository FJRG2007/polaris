/**
 * A channel's incoming webhook: `POST /api/chat/webhooks/<id>/<token>`.
 *
 * Discord's execute-webhook endpoint, closely enough that a tool already posting
 * to a Discord webhook posts here by changing the address: a JSON body with
 * `content` and an optional `username`, `204 No Content` on success, and with
 * `?wait=true` the message back instead. `GET` describes the webhook, as
 * Discord's does.
 *
 * No session: the address is the credential (see `lib/chat/webhooks.ts`). An
 * unknown id and a wrong secret answer the same 404, so the endpoint does not
 * say which half was wrong. Each webhook is held to 30 messages a minute, and
 * each caller to 60 wrong addresses a minute, so neither a runaway script nor a
 * guesser can use it to flood a room or walk the secret space.
 */

import * as core from "@polaris/core";
import { NextResponse } from "next/server";
import { clientIp } from "@/lib/request-context";
import { readCappedBody } from "@/lib/request-body";
import { ChatAccessError } from "@/lib/chat/access";
import { rateLimit } from "@/lib/rate-limit-service";
import { postThroughWebhook, webhookFor } from "@/lib/chat/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Messages one webhook may post per window. Discord's own is about this. */
const PER_WEBHOOK = 30;
/** Wrong addresses one caller may present per window. */
const MISSES = 60;
const WINDOW_MS = 60_000;
/** The most a request body may be. A message is at most 8,000 characters; this
 *  is that plus room for the fields Discord's body carries that are ignored. */
const MAX_BODY_BYTES = 64 * 1024;

type Params = { params: Promise<{ id: string; token: string }> };

export async function GET(_request: Request, { params }: Params): Promise<Response> {
    const { id, token } = await params;
    const webhook = await resolve(id, token);
    if (webhook instanceof Response) return webhook;
    return NextResponse.json({
        id: webhook.id,
        type: 1,
        name: webhook.name,
        channel_id: webhook.channelId
    });
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
    const { id, token } = await params;
    const webhook = await resolve(id, token);
    if (webhook instanceof Response) return webhook;

    const allowed = await rateLimit(`chat-webhook:${webhook.id}`, PER_WEBHOOK, WINDOW_MS);
    if (!allowed.ok) {
        const seconds = Math.max(1, Math.ceil(allowed.retryAfterMs / 1000));
        return NextResponse.json(
            // i18n-ignore read by a machine, not shown to a person
            { message: "You are being rate limited.", retry_after: seconds },
            { status: 429, headers: { "Retry-After": String(seconds) } }
        );
    }

    const bytes = await readCappedBody(request, MAX_BODY_BYTES).catch(() => null);
    if (!bytes) {
        // i18n-ignore read by a machine, not shown to a person
        return NextResponse.json({ message: "Request entity too large" }, { status: 413 });
    }
    let body: unknown = null;
    try {
        body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        body = null;
    }
    const parsed = core.chatWebhookExecuteSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json(
            // i18n-ignore read by a machine, not shown to a person
            { message: parsed.error.issues[0]?.message ?? "Invalid body", code: 50006 },
            { status: 400 }
        );
    }

    try {
        const messageId = await postThroughWebhook(webhook, parsed.data);
        const wait = new URL(request.url).searchParams.get("wait") === "true";
        if (!wait) return new Response(null, { status: 204 });
        return NextResponse.json({
            id: messageId,
            channel_id: webhook.channelId,
            content: parsed.data.content,
            webhook_id: webhook.id
        });
    } catch (caught) {
        if (caught instanceof ChatAccessError) {
            // i18n-ignore read by a machine, not shown to a person
            return NextResponse.json({ message: caught.message }, { status: 403 });
        }
        console.error("polaris: a webhook message could not be posted:", caught);
        // i18n-ignore read by a machine, not shown to a person
        return NextResponse.json({ message: "The message could not be posted" }, { status: 500 });
    }
}

/** The webhook an address names, or the 404 (or 429) to answer with. */
async function resolve(
    id: string,
    token: string
): Promise<{ id: string; channelId: string; name: string } | Response> {
    const ip = (await clientIp()) ?? "unknown";
    const webhook = await webhookFor(id, token);
    if (webhook) return webhook;
    const allowed = await rateLimit(`chat-webhook-miss:${ip}`, MISSES, WINDOW_MS);
    if (!allowed.ok) {
        // i18n-ignore read by a machine, not shown to a person
        return NextResponse.json({ message: "You are being rate limited." }, { status: 429 });
    }
    // i18n-ignore read by a machine, not shown to a person
    return NextResponse.json({ message: "Unknown Webhook", code: 10015 }, { status: 404 });
}
