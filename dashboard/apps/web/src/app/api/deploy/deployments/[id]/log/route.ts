import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/session";
import { requireDeploymentAccess } from "@/lib/deploy-project-access";
import { readDeployment } from "@/lib/deploy-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Current status and log of a deployment (polled by the UI while it runs). */
export async function GET(
    _request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const user = await requirePermission("deploy.read");
    const { id } = await params;
    const access = await requireDeploymentAccess(id, user.id, "logs.read").catch(() => null);
    if (!access) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const result = await readDeployment(id, access.ownerId);
    if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(result);
}
