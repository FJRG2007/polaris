// One agent session as Polar's Code thread shows it, asked again while it runs.
import { z } from "zod";
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { polarCodeThread } from "@/lib/polar/code";
import { codeAnswer } from "@/lib/polar/code-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const query = z.object({ sessionId: z.string().trim().uuid() });

export async function GET(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    // i18n-ignore: a status body no screen shows
    if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
    return codeAnswer(() => polarCodeThread(user, parsed.data.sessionId), "/api/polar/code/thread");
}
