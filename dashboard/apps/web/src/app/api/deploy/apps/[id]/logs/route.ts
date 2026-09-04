import { NextResponse } from "next/server";
import { apiPermission } from "@/lib/api-session";

import { readAppRuntimeLog } from "@/lib/deploy-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Raw runtime stdout/stderr of a deployed app's container - the Deploy Logs view.
 *  Distinct from the build log stored on the deployment. Polled while the tab is
 *  open. */
export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const user = await apiPermission("deploy.read");
    if (user instanceof Response) return user;
    const { id } = await params;
    const tail = Number(new URL(request.url).searchParams.get("tail"));
    const limit = Number.isFinite(tail) && tail > 0 ? Math.min(tail, 5000) : 500;
    try {
        const log = await readAppRuntimeLog(id, user.id, limit);
        return NextResponse.json({ log });
    } catch (caught) {
        return NextResponse.json(
            { error: caught instanceof Error ? caught.message : "Could not read runtime logs" },
            { status: 400 }
        );
    }
}
