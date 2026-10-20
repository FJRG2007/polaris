/**
 * Polar's per-person settings. GET answers all of them; PATCH changes any of
 * `memory` (reading and writing memories; what is saved stays either way) and
 * the chat display switches (`lib/polar/display.ts`), and answers the result.
 */

import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { polarPreferencesPatchSchema } from "@/lib/polar/display";
import { polarPreferences, setPolarPreferences } from "@/lib/polar/preferences";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    return NextResponse.json(await polarPreferences(user.id));
}

export async function PATCH(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    const body = polarPreferencesPatchSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    return NextResponse.json(await setPolarPreferences(user.id, body.data));
}
