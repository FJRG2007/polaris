import { Readable } from "node:stream";
import { apiPermission } from "@/lib/api-session";
import { NextResponse } from "next/server";

import { requireApplicationAccess } from "@/lib/deploy-project-access";
import { readContainerFile } from "@/lib/container-files-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stream a file from inside a deployed container at ?path= for download. */
export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const user = await apiPermission("deploy.read");
    if (user instanceof Response) return user;
    const { id } = await params;
    const path = new URL(request.url).searchParams.get("path");
    if (!path) return NextResponse.json({ error: "path is required" }, { status: 400 });
    try {
        const access = await requireApplicationAccess(id, user.id, "files.read");
        const stream = await readContainerFile(id, access.ownerId, path);
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
