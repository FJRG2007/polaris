// Polar's Code side: the person's own sessions matching a search, by title, repository or prompt.
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { polarCodeSearch } from "@/lib/polar/code";
import { codeAnswer } from "@/lib/polar/code-route";
import { sessionSearchQuery } from "@/lib/agents/session-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const parsed = sessionSearchQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    // i18n-ignore: a status body no screen shows
    if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
    return codeAnswer(
        () => polarCodeSearch(user, parsed.data.q, parsed.data.page),
        "/api/polar/code/search"
    );
}
