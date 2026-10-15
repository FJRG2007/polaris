/**
 * One self-diagnosis check, by id.
 *
 * One request per check rather than one for all of them, so the screen fills
 * each row as its own answer lands instead of waiting on the slowest probe.
 * Every check is bounded by its own timeout (`lib/diagnostics/checks.ts`).
 *
 * Admin-only. Node runtime for Prisma and the TLS probe.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/api-session";
import { checkIdSchema, runCheck } from "@/lib/diagnostics/checks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({ id: checkIdSchema });

export async function GET(request: Request): Promise<Response> {
    const refused = await apiAdmin();
    if (refused instanceof Response) return refused;
    const parsed = querySchema.safeParse({ id: new URL(request.url).searchParams.get("id") });
    if (!parsed.success) return NextResponse.json({ error: "unknown check" }, { status: 400 });
    return NextResponse.json(await runCheck(parsed.data.id), { headers: { "Cache-Control": "no-store" } });
}
