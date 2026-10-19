/**
 * GET /api/polar/attachments/<id> - one of the signed-in person's files given
 * to Polar, for the message that shows it. Somebody else's id answers as a file
 * that does not exist.
 *
 * Served as an attachment unless it is a picture a browser shows safely, and
 * never sniffed, so a text file cannot be turned into a page.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { apiUser } from "@/lib/api-session";
import { readPolarAttachment } from "@/lib/polar/attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

const INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params): Promise<Response> {
    const user = await apiUser();
    if (user instanceof NextResponse) return user;
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return NextResponse.json({ error: "not_found" }, { status: 404 });
    let file: Awaited<ReturnType<typeof readPolarAttachment>>;
    try {
        file = await readPolarAttachment(user.id, id.data);
    } catch (error) {
        console.error("polar: could not read an attachment", error);
        return NextResponse.json({ error: "storage_failed" }, { status: 503 });
    }
    if (!file) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const disposition = INLINE.has(file.mediaType) ? "inline" : "attachment";
    return new Response(file.body, {
        headers: {
            "content-type": file.mediaType,
            "content-disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox",
            "cache-control": "private, max-age=3600"
        }
    });
}
