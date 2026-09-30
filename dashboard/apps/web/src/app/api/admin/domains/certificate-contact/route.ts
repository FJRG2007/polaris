import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/api-session";
import { acmeContactStatus } from "@/lib/tls/acme-edge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The certificate contact address and whether the edge is running with it. Read by
 * the Domains card after its first paint, since it asks the host daemon about the
 * edge container.
 */
export async function GET(): Promise<Response> {
    const refused = await apiAdmin();
    if (refused instanceof Response) return refused;
    return NextResponse.json(await acmeContactStatus());
}
