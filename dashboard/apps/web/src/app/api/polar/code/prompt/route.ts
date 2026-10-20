// Reply to a running agent session from Polar's Code thread. The Agents prompt action validates the body.
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { polarCodePrompt } from "@/lib/polar/code";
import { codeAnswer, jsonBody } from "@/lib/polar/code-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const body = await jsonBody(request);
    return codeAnswer(() => polarCodePrompt(user, body), "/api/polar/code/prompt");
}
