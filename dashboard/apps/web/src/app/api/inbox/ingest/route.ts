import { NextResponse } from "next/server";
import { inboundEventSchema } from "@polaris/messaging";
import { ingestInbound } from "@/lib/messaging-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Internal ingest for inbound messages the bridge forwards. Authenticated by a
 *  shared key on the internal network - never exposed publicly. The event is
 *  treated as untrusted and validated before it touches the database. */
const INGEST_KEY = process.env.MESSAGING_INGEST_KEY ?? "";

export async function POST(request: Request): Promise<Response> {
    if (!INGEST_KEY || request.headers.get("x-internal-key") !== INGEST_KEY) {
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
