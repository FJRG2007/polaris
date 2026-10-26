import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/api-session";
import { tailscaleView } from "@/lib/tailscale/tailscale-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Remote access as it stands, for the Domains card. Reads the component; never
 *  starts it. */
export async function GET(): Promise<Response> {
    const refused = await apiAdmin();
    if (refused instanceof Response) return refused;
    return NextResponse.json(await tailscaleView());
}
