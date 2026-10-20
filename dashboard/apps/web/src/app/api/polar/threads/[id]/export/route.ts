/**
 * GET /api/polar/threads/<id>/export?format=markdown|json - one of the
 * signed-in person's chats as a download. Markdown is the conversation as the
 * screen shows it; JSON keeps every version of every message. Another person's
 * id answers as a chat that does not exist.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { apiUser } from "@/lib/api-session";
import {
    exportFileName,
    exportNames,
    readExportThread,
    threadJson,
    threadMarkdown
} from "@/lib/polar/export";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();
const formatSchema = z.enum(["markdown", "json"]).default("markdown");

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params): Promise<Response> {
    const user = await apiUser();
    if (user instanceof NextResponse) return user;
    const id = idSchema.safeParse((await params).id);
    const format = formatSchema.safeParse(
        new URL(request.url).searchParams.get("format") ?? undefined
    );
    if (!format.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    if (!id.success) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const thread = await readExportThread(user.id, id.data);
    if (!thread) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const markdown = format.data === "markdown";
    const body = markdown ? threadMarkdown(thread, await exportNames()) : threadJson(thread);
    const name = exportFileName(thread.title, thread.id, markdown ? "md" : "json");
    return new Response(body, {
        headers: {
            "Content-Type": markdown
                ? "text/markdown; charset=utf-8"
                : "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="${name}"`,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff"
        }
    });
}
