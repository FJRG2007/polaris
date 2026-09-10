/**
 * The compliance evidence, read after the Evidence screen has painted.
 *
 * Admin-only: it names every administrator and says which protections are off.
 * Reading it is not recorded - taking a copy is, through the export beside this.
 * Node runtime for Prisma.
 */

import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/api-session";
import { readEvidence } from "@/lib/compliance/evidence-readings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await apiAdmin();
    if (user instanceof Response) return user;
    try {
        return NextResponse.json(await readEvidence(), { headers: { "cache-control": "private, no-store" } });
    } catch (caught) {
        console.error("polaris: the compliance evidence could not be read:", caught);
        return NextResponse.json({ error: "The evidence could not be read just now. Try again in a minute." }, { status: 500 });
    }
}
