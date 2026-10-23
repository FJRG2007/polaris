import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/api-session";
import { addressFollowView } from "@/lib/domain-address-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the public-address follower last found, for the Domains card. Read after
 * the first paint; it only reads stored settings.
 */
export async function GET(): Promise<Response> {
    const refused = await apiAdmin();
    if (refused instanceof Response) return refused;
    return NextResponse.json(await addressFollowView());
}
