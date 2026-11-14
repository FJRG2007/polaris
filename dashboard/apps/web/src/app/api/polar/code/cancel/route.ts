// Take a session that has not started out of the queue, from Polar's Code thread.
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { polarCodeCancel } from "@/lib/polar/code";
import { codeAnswer, jsonBody } from "@/lib/polar/code-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const body = await jsonBody(request);
    return codeAnswer(() => polarCodeCancel(user, body), "/api/polar/code/cancel");
}
