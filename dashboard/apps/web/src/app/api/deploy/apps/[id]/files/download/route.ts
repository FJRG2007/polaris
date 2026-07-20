import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/session";
import { readContainerFile } from "@/lib/container-files-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stream a file from inside a deployed container at ?path= for download. */
export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const user = await requirePermission("deploy.read");
    const { id } = await params;
    const path = new URL(request.url).searchParams.get("path");
    if (!path) return NextResponse.json({ error: "path is required" }, { status: 400 });
    try {
        const stream = await readContainerFile(id, user.id, path);
        const name = path.split("/").filter(Boolean).pop() ?? "download";
        return new Response(Readable.toWeb(stream) as ReadableStream, {
            headers: {
                "content-type": "application/octet-stream",
                "content-disposition": `attachment; filename="${name.replace(/"/g, "")}"`
            }
        });
    } catch (caught) {
        return NextResponse.json(
            { error: caught instanceof Error ? caught.message : "Could not read the file" },
            { status: 400 }
        );
    }
}
