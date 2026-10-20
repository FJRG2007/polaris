/**
 * GET /api/polar/shared - the Polar chats other people sent the signed-in
 * person, newest first: Polar's "Shared with you".
 */

import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { listSharedWithMe } from "@/lib/polar/share";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    return NextResponse.json({ shared: await listSharedWithMe(user.id) });
}
