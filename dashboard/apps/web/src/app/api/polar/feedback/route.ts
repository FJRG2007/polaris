/**
 * The signed-in person's good and bad marks on Polar answers. GET
 * `?thread=<id>` reads their marks on one of their chats, `?session=<id>` on a
 * Polar Code session they started; PUT marks one answer (`{ messageId, rating,
 * reasons, note }`, or `sessionMessageId` for a Code session's) or takes the
 * mark back with `rating: null`. An answer in someone else's chat answers as one that does
 * not exist. A mark never changes the answer.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { readCappedBody } from "@/lib/request-body";
import { rateLimit } from "@/lib/rate-limit-service";
import { codeMarksOf, polarMarksOf, setCodeMark, setPolarMark } from "@/lib/polar/answer-feedback-service";
import { polarFeedbackBodySchema, polarMessageIdSchema } from "@/lib/polar/answer-feedback";

export const dynamic = "force-dynamic";

/** A note and its reasons, with room to spare. */
const BODY_MAX = 8 * 1024;

const messageSchema = z.union([
    z.object({ messageId: polarMessageIdSchema }),
    z.object({ sessionMessageId: z.string().uuid() })
]);

function refuse(code: string, status: number): NextResponse {
    return NextResponse.json({ error: code }, { status });
}

export async function GET(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const params = new URL(request.url).searchParams;
    const session = params.get("session");
    const id = z.string().uuid().safeParse(session ?? params.get("thread"));
    if (!id.success) return refuse("invalid", 400);
    const marks = session ? await codeMarksOf(user.id, id.data) : await polarMarksOf(user.id, id.data);
    return NextResponse.json({ marks });
}

export async function PUT(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return refuse("view_as", 403);
    const limited = await rateLimit(`polar-feedback:${user.id}`, 60, 60_000);
    if (!limited.ok) return refuse("rate_limited", 429);
    const bytes = await readCappedBody(request, BODY_MAX);
    if (!bytes) return refuse("too_large", 413);
    let raw: unknown;
    try {
        raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return refuse("invalid", 400);
    }
    const message = messageSchema.safeParse(raw);
    const mark = polarFeedbackBodySchema.safeParse(raw);
    if (!message.success || !mark.success) return refuse("invalid", 400);
    const saved =
        "sessionMessageId" in message.data
            ? await setCodeMark(user.id, message.data.sessionMessageId, mark.data)
            : await setPolarMark(user.id, message.data.messageId, mark.data);
    return saved ? NextResponse.json({ mark: saved }) : refuse("not_found", 404);
}
