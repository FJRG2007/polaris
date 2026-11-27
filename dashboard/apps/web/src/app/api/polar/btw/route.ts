/**
 * POST /api/polar/btw - answers a `/btw` side question about the chat the
 * screen holds (`lib/polar/btw.ts`), with the chat's model and no tools.
 * Nothing is written to the thread: the answer only comes back here.
 */

import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { rateLimit } from "@/lib/rate-limit-service";
import { btwRequestSchema } from "@/lib/polar/btw";
import { answerSideQuestion } from "@/lib/polar/btw-service";

export const dynamic = "force-dynamic";

const STATUS: Record<string, number> = {
    failed: 502,
    no_key: 409,
    unknown_model: 409,
    unsupported_kind: 409
};

export async function POST(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    const body = btwRequestSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    const limited = await rateLimit(`polar-btw:${user.id}`, 20, 60_000);
    if (!limited.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const result = await answerSideQuestion({ userId: user.id, ...body.data });
    if (typeof result === "string") {
        return NextResponse.json({ error: result }, { status: STATUS[result] ?? 400 });
    }
    if ("limit" in result) {
        return NextResponse.json({ error: "usage_limit", ...result.limit }, { status: 429 });
    }
    return NextResponse.json(result);
}
