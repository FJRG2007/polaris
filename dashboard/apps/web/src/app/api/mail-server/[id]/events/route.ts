/**
 * Where a mail server Polaris runs posts its incoming-mail events, signed with
 * the key setup gave it. Nobody signs in here: the signature is the credential,
 * and it is checked over the raw body before anything in it is read (see
 * `lib/mail-server/inbound.ts`).
 */

import { z } from "zod";
import { MAX_EVENT_BODY, receiveEvents } from "@/lib/mail-server/inbound";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
    const { id } = await context.params;
    const serverId = idSchema.safeParse(id);
    if (!serverId.success) return new Response(null, { status: 401 });
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_EVENT_BODY) return new Response(null, { status: 413 });
    const raw = Buffer.from(await request.arrayBuffer());
    if (raw.length > MAX_EVENT_BODY) return new Response(null, { status: 413 });
    const status = await receiveEvents(serverId.data, raw, request.headers.get("x-signature"));
    return new Response(null, { status });
}
