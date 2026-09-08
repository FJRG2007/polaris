import { NextResponse } from "next/server";
import { adminWaiting, NOTHING_WAITING } from "@/lib/admin-waiting";
import { resolveSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What is waiting for an administrator, for whoever is asking.
 *
 * Read from every screen rather than from Management, which is the whole point:
 * a reported message is answered by somebody who spends their day in Deploy, and
 * they can only answer it if something tells them it is there.
 *
 * Nothing waiting rather than a refusal for an account that is not an
 * administrator: the badge is then simply absent, and the layout does not have
 * to know why. It is also the honest answer - there is nothing waiting for
 * somebody who cannot act on any of it.
 */
export async function GET(): Promise<Response> {
    const session = await resolveSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!session.isAdmin) return NextResponse.json(NOTHING_WAITING);
    return NextResponse.json(await adminWaiting());
}
