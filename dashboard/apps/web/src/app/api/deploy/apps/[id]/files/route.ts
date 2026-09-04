import { NextResponse } from "next/server";
import { apiPermission } from "@/lib/api-session";

import { requireApplicationAccess } from "@/lib/deploy-project-access";
import { listContainerFiles, writeContainerFile } from "@/lib/container-files-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List a directory inside a deployed container. */
export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const user = await apiPermission("deploy.read");
    if (user instanceof Response) return user;
    const { id } = await params;
    const path = new URL(request.url).searchParams.get("path") ?? "/";
    try {
        const access = await requireApplicationAccess(id, user.id, "files.read");
        const entries = await listContainerFiles(id, access.ownerId, path);
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
    const user = await apiPermission("deploy.manage");
    if (user instanceof Response) return user;
    const { id } = await params;
    const path = new URL(request.url).searchParams.get("path");
    if (!path) return NextResponse.json({ error: "path is required" }, { status: 400 });
    try {
        const access = await requireApplicationAccess(id, user.id, "files.write");
        const content = Buffer.from(await request.arrayBuffer());
        await writeContainerFile(id, access.ownerId, path, content);
        return NextResponse.json({ ok: true });
    } catch (caught) {
        return NextResponse.json(
            { error: caught instanceof Error ? caught.message : "Could not write the file" },
            { status: 400 }
        );
    }
}
