// A page of the connected repositories, for the Code composer's repository menu.
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { polarCodeRepos } from "@/lib/polar/code";
import { codeAnswer } from "@/lib/polar/code-route";
import { repoOptionsInput } from "@/lib/agents/repo-options";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const params = new URL(request.url).searchParams;
    const id = params.get("id");
    const parsed = repoOptionsInput.safeParse({
        query: params.get("query") ?? "",
        cursor: params.get("cursor") || null,
        ...(id ? { ids: [id] } : {})
    });
    // i18n-ignore: a status body no screen shows
    if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    return codeAnswer(() => polarCodeRepos(user, parsed.data), "/api/polar/code/repos");
}
