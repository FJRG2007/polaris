import { NextResponse } from "next/server";
import { apiPermission } from "@/lib/api-session";

import { readAppHttpLogs } from "@/lib/deploy-service";
import { requireApplicationAccess } from "@/lib/deploy-project-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Recent HTTP access logs for a deployed app, parsed from its container stdout
 *  (nginx/Apache CLF or JSON), newest first. Polled by the HTTP Logs tab. */
export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const user = await apiPermission("deploy.read");
    if (user instanceof Response) return user;
    const { id } = await params;
    const tail = Number(new URL(request.url).searchParams.get("tail"));
    const limit = Number.isFinite(tail) && tail > 0 ? Math.min(tail, 2000) : 500;
    // As whoever owns the project, once the reader may read its logs.
    const access = await requireApplicationAccess(id, user.id, "logs.read").catch(() => null);
    if (!access) return NextResponse.json({ error: "Service not found" }, { status: 404 });
    try {
        const entries = await readAppHttpLogs(id, access.ownerId, limit);
        return NextResponse.json({ entries });
    } catch (caught) {
        return NextResponse.json(
            { error: caught instanceof Error ? caught.message : "Could not read HTTP logs" },
            { status: 400 }
        );
    }
}
