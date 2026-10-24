import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/api-session";
import { backupView } from "@/lib/backup-access/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What backup access last found, for the Domains card. Stored settings only. */
export async function GET(): Promise<Response> {
    const refused = await apiAdmin();
    if (refused instanceof Response) return refused;
    return NextResponse.json(await backupView());
}
