/**
 * POST /api/polar/shared/<id>/continue - copies a chat somebody sent the
 * signed-in person into a new chat of their own and answers its id.
 */

import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { rateLimit } from "@/lib/rate-limit-service";
import { continueReceivedPolarThread } from "@/lib/polar/share";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Params): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    const limited = await rateLimit(`polar-share-continue:${user.id}`, 10, 60_000);
    if (!limited.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const threadId = await continueReceivedPolarThread(user.id, (await params).id);
    return threadId
        ? NextResponse.json({ threadId })
        : NextResponse.json({ error: "not_found" }, { status: 404 });
}
