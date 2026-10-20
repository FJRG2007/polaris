/**
 * The response for a file in a shared Polar chat, the same way the owner's own
 * file route serves it: a picture a browser draws safely inline, anything else
 * as a download, never sniffed and sandboxed so a text file cannot become a
 * page. Never cached by anything shared, since the share can be taken away.
 *
 * Server-only.
 */

import { NextResponse } from "next/server";
import { downloadTicketHeaders } from "@/lib/download-ticket";
import type { readThreadAttachment } from "@/lib/polar/attachments";

const INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

type SharedFile = Awaited<ReturnType<typeof readThreadAttachment>>;

export function sharedFileResponse(request: Request, file: SharedFile): Response {
    if (!file) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const disposition = INLINE.has(file.mediaType) ? "inline" : "attachment";
    return new Response(file.body, {
        headers: {
            "content-type": file.mediaType,
            "content-disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox",
            "cache-control": "private, no-store",
            ...downloadTicketHeaders(request)
        }
    });
}
