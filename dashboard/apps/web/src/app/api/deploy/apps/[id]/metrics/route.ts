import { NextResponse } from "next/server";
import { apiPermission } from "@/lib/api-session";

import { readAppContainerMetrics } from "@/lib/app-container-metrics";
import { requireApplicationAccess } from "@/lib/deploy-project-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Live state + CPU/memory of a deployed app's local container. Reuses the
 *  daemon's read-only docker proxy (inspect + one stats sample). */
export async function GET(
    _request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const user = await apiPermission("deploy.read");
    if (user instanceof Response) return user;
    const { id } = await params;
    // As whoever owns the project, once the reader's standing on it is checked.
    const access = await requireApplicationAccess(id, user.id, "project.read").catch(() => null);
    if (!access) return NextResponse.json({ error: "Service not found" }, { status: 404 });
    try {
        return NextResponse.json(await readAppContainerMetrics(id, access.ownerId));
    } catch (caught) {
        return NextResponse.json(
            { error: caught instanceof Error ? caught.message : "Could not read metrics" },
            { status: 400 }
        );
    }
}
