// The branches of one connected repository, for the Code composer's branch chip.
import { z } from "zod";
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { polarCodeBranches } from "@/lib/polar/code";
import { codeAnswer } from "@/lib/polar/code-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const repoSchema = z.string().uuid();

export async function GET(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const repo = repoSchema.safeParse(new URL(request.url).searchParams.get("repo"));
    if (!repo.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    return codeAnswer(() => polarCodeBranches(user, repo.data), "/api/polar/code/branches");
}
