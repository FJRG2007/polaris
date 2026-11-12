/**
 * The model picker's per-person order and "Recent" group. GET answers both;
 * PUT stores a new order (`{ order: string[] }`) and answers it.
 */

import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { pickerOrderBodySchema } from "@/lib/polar/picker-order";
import { pickerPrefsFor, setPickerOrder } from "@/lib/polar/picker-prefs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    return NextResponse.json(await pickerPrefsFor(user.id));
}

export async function PUT(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    const body = pickerOrderBodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    return NextResponse.json({ order: await setPickerOrder(user.id, body.data.order) });
}
