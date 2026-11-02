/**
 * GET /api/polar/threads/<id>/export?format=markdown|json|html|csv|text - one of the
 * signed-in person's chats as a download. Markdown is the conversation as the
 * screen shows it; JSON keeps every version of every message. Another person's
 * id answers as a chat that does not exist.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { downloadTicketHeaders } from "@/lib/download-ticket";
import {
    exportFileName,
    exportNames,
    readExportThread,
    threadCsv,
    threadHtml,
    threadJson,
    threadMarkdown,
    threadText
} from "@/lib/polar/export";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();
const formatSchema = z.enum(["markdown", "json", "html", "csv", "text"]).default("markdown");

const FORMATS = {
    markdown: { extension: "md", type: "text/markdown; charset=utf-8" },
    json: { extension: "json", type: "application/json; charset=utf-8" },
    html: { extension: "html", type: "text/html; charset=utf-8" },
    csv: { extension: "csv", type: "text/csv; charset=utf-8" },
    text: { extension: "txt", type: "text/plain; charset=utf-8" }
} as const;

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const id = idSchema.safeParse((await params).id);
    const format = formatSchema.safeParse(
        new URL(request.url).searchParams.get("format") ?? undefined
    );
    if (!format.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    if (!id.success) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const thread = await readExportThread(user.id, id.data);
    if (!thread) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const names = await exportNames();
    const body = {
        markdown: () => threadMarkdown(thread, names),
        json: () => threadJson(thread),
        html: () => threadHtml(thread, names),
        csv: () => threadCsv(thread, names),
        text: () => threadText(thread, names)
    }[format.data]();
    const { extension, type } = FORMATS[format.data];
    const name = exportFileName(thread.title, thread.id, extension);
    return new Response(body, {
        headers: {
            ...downloadTicketHeaders(request),
            "Content-Type": type,
            "Content-Disposition": `attachment; filename="${name}"`,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff"
        }
    });
}
