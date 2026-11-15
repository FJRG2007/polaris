// Download a Code session's transcript, as Markdown (?format=md) or JSONL (?format=jsonl).
import { z } from "zod";
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { polarCodeTranscript } from "@/lib/polar/code";
import { TRANSCRIPT_FORMATS } from "@/lib/polar/code-transcript";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
    sessionId: z.string().trim().uuid(),
    format: z.enum(TRANSCRIPT_FORMATS)
});

export async function GET(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
        sessionId: url.searchParams.get("sessionId"),
        format: url.searchParams.get("format")
    });
    // i18n-ignore: status bodies no screen shows; the link is only drawn for a session the reader opened
    if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    const file = await polarCodeTranscript(user, parsed.data.sessionId, parsed.data.format);
    // i18n-ignore: as above
    if (!file) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return new Response(file.body, {
        headers: {
            "content-type": file.type,
            "content-disposition": `attachment; filename="${file.name}"`,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff"
        }
    });
}
