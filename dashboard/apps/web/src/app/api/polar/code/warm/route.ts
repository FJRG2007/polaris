// Keep a spare session machine ready while Code is open. See lib/agents/session-spares.
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { polarCodeWarm } from "@/lib/polar/code";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    return NextResponse.json(await polarCodeWarm(user));
}
