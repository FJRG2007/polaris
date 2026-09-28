import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { inboundEventSchema } from "@polaris/messaging";
import { ingestInbound } from "@/lib/messaging-service";
import { resolveBridge } from "@/lib/messaging/bridge-endpoint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The expected ingest key: the static env override, else the marketplace-installed
 *  bridge's key. Kept in sync with what the bridge stamps on inbound events. */
async function expectedIngestKey(): Promise<string> {
    const fromEnv = (process.env.MESSAGING_INGEST_KEY ?? "").trim();
    if (fromEnv) return fromEnv;
    return (await resolveBridge())?.ingestKey ?? "";
}

/** Compared on digests, so the time it takes says nothing about how much of the
 *  key was right - the route answers on the same origin as everything else. */
function sameKey(presented: string, expected: string): boolean {
    const digest = (value: string) => createHash("sha256").update(value).digest();
    return timingSafeEqual(digest(presented), digest(expected));
}

/** Internal ingest for inbound messages the bridge forwards. Authenticated by a
 *  shared key on the internal network - never exposed publicly. The event is
 *  treated as untrusted and validated before it touches the database. */
export async function POST(request: Request): Promise<Response> {
    const expected = await expectedIngestKey();
    const presented = request.headers.get("x-internal-key");
    if (!expected || !sameKey(presented ?? "", expected)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const parsed = inboundEventSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json(
            { error: parsed.error?.issues[0]?.message ?? "Invalid event" },
            { status: 400 }
        );
    }
    try {
        await ingestInbound(parsed.data);
        return NextResponse.json({ ok: true });
    } catch (caught) {
        return NextResponse.json(
            { error: caught instanceof Error ? caught.message : "Ingest failed" },
            { status: 500 }
        );
    }
}
