import { NextResponse } from "next/server";
import { apiPermission } from "@/lib/api-session";

import { readAppHttpLogs } from "@/lib/deploy-service";

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
    try {
        const entries = await readAppHttpLogs(id, user.id, limit);
        return NextResponse.json({ entries });
    } catch (caught) {
        return NextResponse.json(
            { error: caught instanceof Error ? caught.message : "Could not read HTTP logs" },
            { status: 400 }
        );
    }
}
