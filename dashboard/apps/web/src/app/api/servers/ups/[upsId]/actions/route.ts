/** The instant commands run and variables set on one UPS, newest first. */

import { z } from "zod";
import * as upsData from "@/lib/ups/ups-data";
import { upsAdmin, upsFromPath } from "../../guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const kindSchema = z.enum(["command", "variable"]).optional().catch(undefined);

export async function GET(
    request: Request,
    { params }: { params: Promise<{ upsId: string }> }
): Promise<Response> {
    const user = await upsAdmin();
    if (user instanceof Response) return user;
    const row = await upsFromPath(params);
    if (row instanceof Response) return row;
    const kind = kindSchema.parse(new URL(request.url).searchParams.get("kind") ?? undefined);
    return Response.json({ actions: await upsData.listActions(row.id, kind) });
}
