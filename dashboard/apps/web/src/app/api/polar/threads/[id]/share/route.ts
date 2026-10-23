/**
 * The read-only public link of one of the signed-in person's Polar chats.
 * GET reads it (`link: null` when it is not shared), POST makes it - or moves
 * an existing link's snapshot to now, keeping its address; a body of
 * `{ upTo }` ends the snapshot at that answer - and DELETE stops
 * serving it - `?everyone=1` also takes it back from every person it was sent
 * to. Another person's id answers as a thread that does not exist.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { readCappedBody } from "@/lib/request-body";
import { rateLimit } from "@/lib/rate-limit-service";
import { polarMessageIdSchema } from "@/lib/polar/answer-feedback";
import * as core from "@polaris/core";
import {
    polarShareLink,
    revokePolarShare,
    setPolarShareLimits,
    sharePolarThread
} from "@/lib/polar/share";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

const BODY_MAX = 1024;

/** No body (the end point the link had) or the answer it ends at (null for the whole chat). */
const shareSchema = z.object({ upTo: polarMessageIdSchema.nullish() }).nullable();

type Params = { params: Promise<{ id: string }> };

const NOT_FOUND = () => NextResponse.json({ error: "not_found" }, { status: 404 });

export async function GET(_request: Request, { params }: Params): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return NOT_FOUND();
    return NextResponse.json({ link: await polarShareLink(user.id, id.data) });
}

export async function POST(request: Request, { params }: Params): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return NOT_FOUND();
    const bytes = await readCappedBody(request, BODY_MAX).catch(() => new Uint8Array(0));
    if (!bytes) return NextResponse.json({ error: "too_large" }, { status: 413 });
    const text = new TextDecoder().decode(bytes);
    let raw: unknown = null;
    try {
        raw = text.trim() ? JSON.parse(text) : null;
    } catch {
        return NextResponse.json({ error: "invalid" }, { status: 400 });
    }
    const body = shareSchema.safeParse(raw);
    if (!body.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    const limited = await rateLimit(`polar-share:${user.id}`, 20, 60_000);
    if (!limited.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const link = await sharePolarThread(user.id, id.data, body.data?.upTo);
    return link ? NextResponse.json({ link }) : NOT_FOUND();
}

/** A limits body names address lists, so it gets more room than a snapshot. */
const LIMITS_BODY_MAX = 32 * 1024;

const limitsSchema = z.object({ limits: core.linkLimitsSchema });

/** PATCH saves the link's limits - password, expiry, cap, addresses - and
 *  leaves its snapshot where it was. */
export async function PATCH(request: Request, { params }: Params): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return NOT_FOUND();
    const bytes = await readCappedBody(request, LIMITS_BODY_MAX).catch(() => new Uint8Array(0));
    if (!bytes) return NextResponse.json({ error: "too_large" }, { status: 413 });
    let raw: unknown = null;
    try {
        raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return NextResponse.json({ error: "invalid" }, { status: 400 });
    }
    const body = limitsSchema.safeParse(raw);
    if (!body.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    const limited = await rateLimit(`polar-share:${user.id}`, 20, 60_000);
    if (!limited.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const link = await setPolarShareLimits(user.id, id.data, body.data.limits);
    return link ? NextResponse.json({ link }) : NOT_FOUND();
}

export async function DELETE(request: Request, { params }: Params): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return NOT_FOUND();
    const everyone = new URL(request.url).searchParams.get("everyone") === "1";
    return (await revokePolarShare(user.id, id.data, everyone))
        ? NextResponse.json({ ok: true })
        : NOT_FOUND();
}
