import { NextResponse } from "next/server";
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

/** Internal ingest for inbound messages the bridge forwards. Authenticated by a
 *  shared key on the internal network - never exposed publicly. The event is
 *  treated as untrusted and validated before it touches the database. */
export async function POST(request: Request): Promise<Response> {
    const expected = await expectedIngestKey();
    const presented = request.headers.get("x-internal-key");
    if (!expected || presented !== expected) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const parsed = inboundEventSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error?.issues[0]?.message ?? "Invalid event" }, { status: 400 });
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
