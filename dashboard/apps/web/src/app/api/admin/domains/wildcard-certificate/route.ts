import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/api-session";
import { wildcardCertView } from "@/lib/wildcard-cert-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Whether the deploy addresses are covered by a trusted wildcard certificate, and
 *  why not. Read by the Certificates card after its first paint. */
export async function GET(): Promise<Response> {
    const refused = await apiAdmin();
    if (refused instanceof Response) return refused;
    return NextResponse.json(await wildcardCertView());
}
