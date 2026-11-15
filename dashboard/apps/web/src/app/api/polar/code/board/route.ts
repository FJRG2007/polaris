// Polar Code's session board: the running sessions in reach and a page of the finished ones, or the next page of Done.
import { NextResponse } from "next/server";
import { userHasManage } from "@/lib/session";
import { polarCaller } from "@/lib/polar/access";
import { codeAnswer } from "@/lib/polar/code-route";
import { BOARD_FILTERS } from "@/lib/agents/session-board";
import { readCodeBoard, readDonePage } from "@/lib/polar/code-board";
import { sessionCursorSchema } from "@/lib/agents/session-cursor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const query = BOARD_FILTERS.extend({ done: sessionCursorSchema.optional() }).strict();

export async function GET(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    if (!(await userHasManage(user, "agents.read")))
        // i18n-ignore: a status body no screen shows; the page draws its own refusal
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    // i18n-ignore: a status body no screen shows
    if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
    const { done, ...filters } = parsed.data;
    return codeAnswer(
        () => (done ? readDonePage(user.id, filters, done) : readCodeBoard(user.id, filters)),
        "/api/polar/code/board"
    );
}
