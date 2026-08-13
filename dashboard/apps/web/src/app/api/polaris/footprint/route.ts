import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/session";
import { readPolarisFootprint } from "@/lib/polaris-footprint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What Polaris itself is using, part by part.
 *
 * Its own endpoint rather than a field on the container listing, because it costs
 * a different order of magnitude: the listing is one call and a sample, this
 * inspects every part of the stack and asks each one to measure its volumes. The
 * page paints its table first and this lands after.
 *
 * Behind the same permission as the Containers page it is shown on: every figure
 * here is about containers that page already lists.
 */
export async function GET(request: Request): Promise<Response> {
    await requirePermission("deploy.read");
    const fresh = new URL(request.url).searchParams.get("fresh") === "1";
    try {
        return NextResponse.json(await readPolarisFootprint(fresh));
    } catch (caught) {
        // Nothing here can be a bad request: there is nothing to get wrong but the
        // one flag above. Everything that fails does so behind this - the engine
        // being unreachable, hostd refusing, an inspect timing out - so it is
        // reported as what it is, and stays legible to logs and retries.
        return NextResponse.json(
            { error: caught instanceof Error ? caught.message : "Could not measure Polaris" },
            { status: 502 }
        );
    }
}
