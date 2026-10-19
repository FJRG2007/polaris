/**
 * GET /api/polar/threads - the signed-in person's conversations with Polar,
 * newest first, fifty at a time (`?cursor=<id>` for the next page).
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { apiUser } from "@/lib/api-session";
import { listPolarThreads } from "@/lib/polar/threads";

export const dynamic = "force-dynamic";

const querySchema = z.object({ cursor: z.string().uuid().optional() });

export async function GET(request: Request): Promise<Response> {
    const user = await apiUser();
    if (user instanceof NextResponse) return user;
    const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    return NextResponse.json({ threads: await listPolarThreads(user.id, query.data.cursor) });
}
