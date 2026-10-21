// Polar's Code side: whether it is open to this account, and a page of its own agent sessions. Asked again on a timer.
import { z } from "zod";
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { codeAnswer } from "@/lib/polar/code-route";
import { polarCodeOverview } from "@/lib/polar/code";
import { sessionCursorSchema } from "@/lib/agents/session-cursor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const query = z.object({ after: sessionCursorSchema.optional() }).strict();

export async function GET(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    // i18n-ignore: a status body no screen shows
    if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
    return codeAnswer(() => polarCodeOverview(user, parsed.data.after ?? null), "/api/polar/code");
}
