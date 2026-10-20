// Polar's Code side: whether it is open to this account, and its agent sessions. Asked again on a timer.
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { codeAnswer } from "@/lib/polar/code-route";
import { polarCodeOverview } from "@/lib/polar/code";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    return codeAnswer(() => polarCodeOverview(user), "/api/polar/code");
}
