// Carry on with an ended agent session in a new one, from Polar's Code thread. The Agents fork action validates the id.
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { polarCodeContinue } from "@/lib/polar/code";
import { codeAnswer, jsonBody } from "@/lib/polar/code-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const body = await jsonBody(request);
    return codeAnswer(() => polarCodeContinue(user, body), "/api/polar/code/continue");
}
