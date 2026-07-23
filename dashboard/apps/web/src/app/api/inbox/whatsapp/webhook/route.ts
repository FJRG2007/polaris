/**
 * WhatsApp Cloud (Meta) webhook. GET handles the subscription verification
 * handshake; POST receives inbound messages, verified with the app secret
 * (X-Hub-Signature-256) before anything is trusted. Each message is mapped to its
 * channel by the Meta phone-number id and ingested through the messaging service.
 */

import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { findCloudChannelByPhoneNumberId, ingestInbound } from "@/lib/messaging-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VERIFY_TOKEN = process.env.MESSAGING_WA_VERIFY_TOKEN ?? "";
const APP_SECRET = process.env.MESSAGING_WA_APP_SECRET ?? "";

export function GET(request: Request): Response {
    const url = new URL(request.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && VERIFY_TOKEN.length > 0 && token === VERIFY_TOKEN && challenge) {
        return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
    }
    return new Response("Forbidden", { status: 403 });
}

function verifySignature(raw: string, header: string | null): boolean {
    if (!APP_SECRET || !header) return false;
    const expected = `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}`;
    const a = Buffer.from(expected);
    const b = Buffer.from(header);
    return a.length === b.length && timingSafeEqual(a, b);
}

interface WaMessage {
    from: string;
    id?: string;
    type: string;
    text?: { body?: string };
    interactive?: { button_reply?: { id?: string }; list_reply?: { id?: string } };
}

interface WaValue {
    metadata?: { phone_number_id?: string };
    contacts?: { profile?: { name?: string }; wa_id?: string }[];
    messages?: WaMessage[];
}

interface WaPayload {
    entry?: { changes?: { value?: WaValue }[] }[];
}

export async function POST(request: Request): Promise<Response> {
    const raw = await request.text();
    if (!verifySignature(raw, request.headers.get("x-hub-signature-256"))) {
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
    let payload: WaPayload;
    try {
        payload = JSON.parse(raw) as WaPayload;
    } catch {
        return NextResponse.json({ error: "Malformed payload" }, { status: 400 });
    }

    for (const entry of payload.entry ?? []) {
        for (const change of entry.changes ?? []) {
            const value = change.value;
            const phoneNumberId = value?.metadata?.phone_number_id;
            if (!phoneNumberId || !value?.messages?.length) continue;
            const channelId = await findCloudChannelByPhoneNumberId(phoneNumberId);
            if (!channelId) continue;
            const peerName = value.contacts?.[0]?.profile?.name;
            for (const message of value.messages) {
                const selection = message.interactive?.button_reply?.id ?? message.interactive?.list_reply?.id;
                await ingestInbound({
                    channelId,
                    peerId: message.from,
                    peerName,
                    externalId: message.id,
                    kind: selection ? "interactive" : "text",
                    body: message.text?.body,
                    selection,
                    at: Date.now()
                });
            }
        }
    }

    // Meta expects a prompt 200 regardless of downstream handling.
    return NextResponse.json({ ok: true });
}
