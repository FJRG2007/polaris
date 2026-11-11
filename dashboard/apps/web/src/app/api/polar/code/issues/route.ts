// The open issues of one connected repository, for the Code composer's issue chip.
import { z } from "zod";
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { polarCodeIssues } from "@/lib/polar/code";
import { codeAnswer } from "@/lib/polar/code-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const query = z.object({
    repo: z.string().uuid(),
    q: z.string().trim().max(200).default("")
});

export async function GET(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    // i18n-ignore: a status body no screen shows
    if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    return codeAnswer(
        () => polarCodeIssues(user, parsed.data.repo, parsed.data.q),
        "/api/polar/code/issues"
    );
}
