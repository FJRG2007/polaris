/**
 * One UPS: what it says now and its history over `?hours=` (1 to 720, 24 by
 * default). Polled by the UPS screen while it is open.
 */

import { z } from "zod";
import * as upsService from "@/lib/ups/ups-service";
import { upsReached } from "../guard";
import { visitorResult, visitorView } from "@/lib/ups/ups-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const hoursSchema = z.coerce.number().int().min(1).max(720).catch(24);

export async function GET(
    request: Request,
    { params }: { params: Promise<{ upsId: string }> }
): Promise<Response> {
    // A visitor lent it to watch reads it too: its status and history are what
    // they were lent.
    const reached = await upsReached(params, "watch");
    if (reached instanceof Response) return reached;
    const { row, standing } = reached;
    const hours = hoursSchema.parse(new URL(request.url).searchParams.get("hours") ?? undefined);
    const [result, history] = await Promise.all([
        upsService.readUps(row, upsService.usbListing(), { writable: true }),
        upsService.upsHistory(row.id, hours)
    ]);
    const view = upsService.toView(row);
    return Response.json({
        ups: standing.manage ? view : visitorView(view),
        result: standing.manage ? result : visitorResult(result, standing.control),
        history
    });
}
