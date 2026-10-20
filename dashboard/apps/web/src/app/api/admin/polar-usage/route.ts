/**
 * GET /api/admin/polar-usage - what Polar has spent this month on the key this
 * Polaris shares, and who spent it. Admin-only: it names people. Read after
 * the Consumption screen has painted, like the rest of that screen.
 */

import { NextResponse } from "next/server";
import { backgroundUser } from "@/lib/session";
import { sharedKeySpend } from "@/lib/polar/usage";
import { readerWords } from "@/lib/i18n/reader-words";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await backgroundUser();
    if (!user?.isAdmin) {
        return NextResponse.json(
            { error: (await readerWords("api"))("errors.forbidden") },
            { status: 403 }
        );
    }
    return NextResponse.json(await sharedKeySpend());
}
