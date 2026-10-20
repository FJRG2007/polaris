/**
 * One Polar chat somebody sent the signed-in person. GET reads its snapshot,
 * checked against the recipient row on every read; DELETE takes it off their
 * own list. One that is not theirs, or was taken back, answers 404.
 */

import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { dismissReceivedPolarThread, readReceivedPolarThread } from "@/lib/polar/share";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const thread = await readReceivedPolarThread(user.id, (await params).id);
    return thread
        ? NextResponse.json({ thread })
        : NextResponse.json({ error: "not_found" }, { status: 404 });
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    await dismissReceivedPolarThread(user.id, (await params).id);
    return NextResponse.json({ ok: true });
}
