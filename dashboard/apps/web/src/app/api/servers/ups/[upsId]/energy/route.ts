/**
 * One UPS's energy and cost in `?unit=hour|day|month` buckets between
 * `?from=` and `?to=`, in the reader's `?tz=`, with the totals.
 */

import * as upsData from "@/lib/ups/ups-data";
import * as upsSettings from "@/lib/ups/ups-settings";
import { badRequest, upsReached } from "../../guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
    request: Request,
    { params }: { params: Promise<{ upsId: string }> }
): Promise<Response> {
    const reached = await upsReached(params, "watch");
    if (reached instanceof Response) return reached;
    const { row } = reached;
    const query = upsSettings.energyQuerySchema.safeParse(
        Object.fromEntries(new URL(request.url).searchParams)
    );
    if (!query.success) return badRequest();
    const buckets = await upsData.energyRollup([row.id], query.data);
    return Response.json({ buckets, totals: upsData.energyTotals(buckets) });
}
