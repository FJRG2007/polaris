/**
 * POST /api/polar/threads/:id/compact - summarises the conversation up to one
 * message and saves the summary as a compaction marker under it, so later
 * turns send the summary and what follows instead of the whole history
 * (`/compact [instructions]`, and the automatic one near the model's window).
 * Answers the marker message for the screen to append.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { rateLimit } from "@/lib/rate-limit-service";
import { polarLimitReached } from "@/lib/polar/usage";
import { modelChoiceSchema } from "@/lib/polar/shared";
import { compactPolarThread } from "@/lib/polar/compact-thread";
import { POLAR_COMPACT_INSTRUCTIONS_MAX } from "@/lib/polar/compaction";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();
const bodySchema = z
    .object({
        /** The newest message of the path being compacted. */
        messageId: z.string().trim().min(1).max(64),
        choice: modelChoiceSchema,
        instructions: z
            .string()
            .trim()
            .max(POLAR_COMPACT_INSTRUCTIONS_MAX)
            .transform((value) => value || null)
            .nullable()
            .default(null),
        auto: z.boolean().default(false)
    })
    .strict();

type Params = { params: Promise<{ id: string }> };

const STATUS: Record<string, number> = {
    not_found: 404,
    nothing: 409,
    failed: 502,
    no_key: 409,
    unknown_model: 409,
    unsupported_kind: 409
};

export async function POST(request: Request, { params }: Params): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    if (user.viewingAs) return NextResponse.json({ error: "view_as" }, { status: 403 });
    const id = idSchema.safeParse((await params).id);
    if (!id.success) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const body = bodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    const limited = await rateLimit(`polar-compact:${user.id}`, 10, 60_000);
    if (!limited.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    // A summary spends tokens like a turn, so the shared key's ceilings hold.
    if (body.data.choice.payer !== "own") {
        const hit = await polarLimitReached(user.id);
        if (hit) return NextResponse.json({ error: "usage_limit", ...hit }, { status: 429 });
    }
    const result = await compactPolarThread({
        userId: user.id,
        threadId: id.data,
        leafId: body.data.messageId,
        choice: body.data.choice,
        instructions: body.data.instructions,
        auto: body.data.auto
    });
    if (typeof result === "string") {
        return NextResponse.json({ error: result }, { status: STATUS[result] ?? 400 });
    }
    return NextResponse.json(result);
}
