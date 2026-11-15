// The person's paired computers, for the Code composer's place picker.
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { polarCodeComputers } from "@/lib/polar/code";
import { codeAnswer } from "@/lib/polar/code-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    return codeAnswer(() => polarCodeComputers(user), "/api/polar/code/computers");
}
