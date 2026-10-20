/**
 * The read-only public link of one of the signed-in person's Polar chats.
 * GET reads it (`link: null` when it is not shared), POST makes it - or moves
 * an existing link's snapshot to now, keeping its address - and DELETE stops
 * serving it. Another person's id answers as a thread that does not exist.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { apiUser } from "@/lib/api-session";
import { rateLimit } from "@/lib/rate-limit-service";
import { polarShareLink, revokePolarShare, sharePolarThread } from "@/lib/polar/share";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

type Params = { params: Promise<{ id: string }> };

const NOT_FOUND = () => NextResponse.json({ error: "not_found" }, { status: 404 });

export async function GET(_request: Request, { params }: Params): Promise<Response> {
    const user = await apiUser();
    if (user instanceof NextResponse) return user;
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return NOT_FOUND();
    return NextResponse.json({ link: await polarShareLink(user.id, id.data) });
}

export async function POST(_request: Request, { params }: Params): Promise<Response> {
    const user = await apiUser();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return NOT_FOUND();
    const limited = await rateLimit(`polar-share:${user.id}`, 20, 60_000);
    if (!limited.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const link = await sharePolarThread(user.id, id.data);
    return link ? NextResponse.json({ link }) : NOT_FOUND();
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
    const user = await apiUser();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return NOT_FOUND();
    return (await revokePolarShare(user.id, id.data))
        ? NextResponse.json({ ok: true })
        : NOT_FOUND();
}
