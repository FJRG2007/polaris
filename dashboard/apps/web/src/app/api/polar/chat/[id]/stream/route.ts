/**
 * The answer a Polar chat is giving right now.
 *
 * GET replays it from its first chunk and follows it live - what
 * `useChat({ resume: true })` asks for when a chat is opened again - or answers
 * 204 when nothing is running there. DELETE stops it: leaving a chat never
 * does, so the stop button has to say so.
 *
 * Owner-scoped: another person's thread answers as one with nothing running.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { UI_MESSAGE_STREAM_HEADERS } from "ai";
import { polarCaller } from "@/lib/polar/access";
import { replayPolarRun, stopPolarRun } from "@/lib/polar/runs";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return new Response(null, { status: 204 });
    const stream = replayPolarRun(user.id, id.data, request.signal);
    if (!stream) return new Response(null, { status: 204 });
    return new Response(stream.pipeThrough(new TextEncoderStream()), {
        headers: UI_MESSAGE_STREAM_HEADERS
    });
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ stopped: stopPolarRun(user.id, id.data) });
}
