/**
 * Polar's per-person settings. PATCH `{ memory }` turns reading and writing
 * memories on or off; what is saved stays either way.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { polarMemoryEnabled, setPolarMemoryEnabled } from "@/lib/polar/memory";

export const dynamic = "force-dynamic";

const patchSchema = z.object({ memory: z.boolean() }).strict();

export async function GET(): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    return NextResponse.json({ memory: await polarMemoryEnabled(user.id) });
}

export async function PATCH(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    const body = patchSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    await setPolarMemoryEnabled(user.id, body.data.memory);
    return NextResponse.json({ memory: body.data.memory });
}
