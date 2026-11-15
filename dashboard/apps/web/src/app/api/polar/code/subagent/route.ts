// A finished subagent's own transcript, from Polar's Code thread, by session and agent id.
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { polarCodeSubagentTranscript } from "@/lib/polar/code";
import { codeAnswer } from "@/lib/polar/code-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const query = Object.fromEntries(new URL(request.url).searchParams);
    return codeAnswer(() => polarCodeSubagentTranscript(user, query), "/api/polar/code/subagent");
}
