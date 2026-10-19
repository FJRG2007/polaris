/**
 * One UPS's energy and cost in `?unit=hour|day|month` buckets between
 * `?from=` and `?to=`, in the reader's `?tz=`, with the totals.
 */

import * as upsData from "@/lib/ups/ups-data";
import * as upsSettings from "@/lib/ups/ups-settings";
import { badRequest, upsAdmin, upsFromPath } from "../../guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
    request: Request,
    { params }: { params: Promise<{ upsId: string }> }
): Promise<Response> {
    const user = await upsAdmin();
    if (user instanceof Response) return user;
    const row = await upsFromPath(params);
    if (row instanceof Response) return row;
    const query = upsSettings.energyQuerySchema.safeParse(
        Object.fromEntries(new URL(request.url).searchParams)
    );
    if (!query.success) return badRequest();
    const buckets = await upsData.energyRollup([row.id], query.data);
    return Response.json({ buckets, totals: upsData.energyTotals(buckets) });
}
