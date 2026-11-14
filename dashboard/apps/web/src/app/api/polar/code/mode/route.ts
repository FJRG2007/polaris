// Change a running session's permission mode, from Polar's Code thread.
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { polarCodeMode } from "@/lib/polar/code";
import { codeAnswer, jsonBody } from "@/lib/polar/code-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const body = await jsonBody(request);
    return codeAnswer(() => polarCodeMode(user, body), "/api/polar/code/mode");
}
