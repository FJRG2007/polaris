/**
 * Every UPS side by side over the last `?days=` (1 to 365): energy, cost,
 * events, outages and load, and the daily energy of each for one chart.
 */

import { z } from "zod";
import * as upsData from "@/lib/ups/ups-data";
import * as upsSettings from "@/lib/ups/ups-settings";
import { upsAdmin } from "../guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const daysSchema = z.coerce.number().int().min(1).max(365).catch(30);

export async function GET(request: Request): Promise<Response> {
    const user = await upsAdmin();
    if (user instanceof Response) return user;
    const search = new URL(request.url).searchParams;
    const days = daysSchema.parse(search.get("days") ?? undefined);
    return Response.json(await upsData.analytics(days, upsSettings.safeTimeZone(search.get("tz"))));
}
