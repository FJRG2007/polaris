/**
 * The people one of the signed-in person's Polar chats was sent to. GET lists
 * them, POST sends the chat (as it is now) to more, with an optional note, and
 * DELETE `?user=<id>` takes it back from one. Another person's chat answers as
 * one that does not exist.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import * as share from "@/lib/polar/share";
import { polarCaller } from "@/lib/polar/access";
import { rateLimit } from "@/lib/rate-limit-service";
import { polarMessageIdSchema } from "@/lib/polar/answer-feedback";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

const sendSchema = z.object({
    userIds: z.array(z.string().uuid()).min(1).max(share.POLAR_SHARE_SEND_MOST),
    note: z.string().trim().max(share.POLAR_SHARE_NOTE_MAX).nullish(),
    /** The answer the snapshot ends at; null sends the whole chat, absent keeps the end point it had. */
    upTo: polarMessageIdSchema.nullish()
});

type Params = { params: Promise<{ id: string }> };

const NOT_FOUND = () => NextResponse.json({ error: "not_found" }, { status: 404 });

export async function GET(_request: Request, { params }: Params): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return NOT_FOUND();
    const people = await share.listShareRecipients(user.id, id.data);
    return people ? NextResponse.json({ people }) : NOT_FOUND();
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return NOT_FOUND();
    const body = sendSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    const limited = await rateLimit(`polar-share-people:${user.id}`, 10, 60_000);
    if (!limited.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const result = await share.sendPolarShare(
        { id: user.id, name: user.name ?? null },
        id.data,
        body.data.userIds,
        body.data.note || null,
        body.data.upTo
    );
    if (result.ok) return NextResponse.json({ sent: result.sent, people: result.recipients });
    if (result.error === "not_found") return NOT_FOUND();
    return NextResponse.json({ error: result.error }, { status: 400 });
}

export async function DELETE(request: Request, { params }: Params): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    const id = idSchema.safeParse((await params).id);
    const person = idSchema.safeParse(new URL(request.url).searchParams.get("user"));
    if (!id.success || !person.success) return NOT_FOUND();
    return (await share.removeShareRecipient(user.id, id.data, person.data))
        ? NextResponse.json({ ok: true })
        : NOT_FOUND();
}
