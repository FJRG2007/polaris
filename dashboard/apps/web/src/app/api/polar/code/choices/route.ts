// What Polar's Code composer offers: repositories and agents, from the Agents app's own choices.
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { polarCodeChoices } from "@/lib/polar/code";
import { codeAnswer } from "@/lib/polar/code-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    return codeAnswer(() => polarCodeChoices(user), "/api/polar/code/choices");
}
