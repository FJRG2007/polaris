import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/session";
import { listContainerFiles, writeContainerFile } from "@/lib/container-files-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List a directory inside a deployed container. */
export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const user = await requirePermission("deploy.read");
    const { id } = await params;
    const path = new URL(request.url).searchParams.get("path") ?? "/";
    try {
        const entries = await listContainerFiles(id, user.id, path);
        return NextResponse.json({ path, entries });
    } catch (caught) {
        return NextResponse.json(
            { error: caught instanceof Error ? caught.message : "Could not list files" },
            { status: 400 }
        );
    }
}

/** Upload (write) a file inside a deployed container at ?path=. */
export async function PUT(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const user = await requirePermission("deploy.manage");
    const { id } = await params;
    const path = new URL(request.url).searchParams.get("path");
    if (!path) return NextResponse.json({ error: "path is required" }, { status: 400 });
    try {
        const content = Buffer.from(await request.arrayBuffer());
        await writeContainerFile(id, user.id, path, content);
        return NextResponse.json({ ok: true });
    } catch (caught) {
        return NextResponse.json(
            { error: caught instanceof Error ? caught.message : "Could not write the file" },
            { status: 400 }
        );
    }
}
