import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/session";
import { readAppContainerMetrics } from "@/lib/app-container-metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Live state + CPU/memory of a deployed app's local container. Reuses the
 *  daemon's read-only docker proxy (inspect + one stats sample). */
export async function GET(
    _request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const user = await requirePermission("deploy.read");
    const { id } = await params;
    try {
        return NextResponse.json(await readAppContainerMetrics(id, user.id));
    } catch (caught) {
        return NextResponse.json(
            { error: caught instanceof Error ? caught.message : "Could not read metrics" },
            { status: 400 }
        );
    }
}
