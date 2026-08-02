/**
 * The admin activity feed, read after the screen has painted.
 *
 * The Activity screen renders its chrome immediately and asks for the rows from
 * here, so a navigation never waits on the audit query. Admin-only: the log
 * carries every actor and target across the deployment. Node runtime for Prisma.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { listActivityFeed } from "@/lib/audit-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Bounded so one request can never ask for the whole log. */
const querySchema = z.object({
    limit: z.coerce.number().int().min(1).max(500).default(200)
});

export async function GET(request: Request): Promise<Response> {
    const session = await getSession();
    if (!(session?.user as { isAdmin?: boolean } | undefined)?.isAdmin) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) {
        return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
    }

    return NextResponse.json({ items: await listActivityFeed(parsed.data.limit) });
}
