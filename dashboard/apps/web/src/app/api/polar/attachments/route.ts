/**
 * POST /api/polar/attachments?name=<file name> - one picture or file for a
 * message to Polar. The body is the file; its Content-Type says what it is.
 * Answers the address the message names it by.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { apiUser } from "@/lib/api-session";
import { readCappedBody } from "@/lib/request-body";
import { rateLimit } from "@/lib/rate-limit-service";
import { acceptedType, storePolarAttachment, POLAR_ATTACHMENT_MAX_BYTES } from "@/lib/polar/attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({ name: z.string().trim().min(1).max(255) });

export async function POST(request: Request): Promise<Response> {
    const user = await apiUser();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    const limited = await rateLimit(`polar-upload:${user.id}`, 30, 60_000);
    if (!limited.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    const mediaType = acceptedType(request.headers.get("content-type"));
    if (!mediaType) return NextResponse.json({ error: "unsupported_type" }, { status: 415 });

    const bytes = await readCappedBody(request, POLAR_ATTACHMENT_MAX_BYTES);
    if (!bytes) return NextResponse.json({ error: "too_large" }, { status: 413 });
    if (bytes.byteLength === 0) return NextResponse.json({ error: "invalid" }, { status: 400 });
    try {
        const file = await storePolarAttachment({ userId: user.id, name: query.data.name, mediaType, bytes });
        return NextResponse.json({ file });
    } catch (error) {
        console.error("polar: could not store an attachment", error);
        return NextResponse.json({ error: "storage_failed" }, { status: 503 });
    }
}
