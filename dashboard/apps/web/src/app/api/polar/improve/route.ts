/**
 * POST /api/polar/improve - a draft rewritten before it is sent: a prompt made
 * clearer, an email body or a task's text corrected
 * (`lib/polar/improve-text.ts`). `orgId` is the organization the text belongs
 * to, whose writing guide it follows when the caller is a member. Answers
 * `{ text }`, or `{ error }` naming why nothing came back.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit-service";
import { polarAccessFor, polarCaller } from "@/lib/polar/access";
import { improveText } from "@/lib/polar/improve-text";
import { IMPROVE_PURPOSES, IMPROVE_TEXT_MAX } from "@/lib/polar/improve-draft";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
    text: z.string().trim().min(1).max(IMPROVE_TEXT_MAX),
    purpose: z.enum(IMPROVE_PURPOSES),
    subject: z.string().trim().max(998).nullish(),
    orgId: z.string().uuid().nullish(),
    /** A task space the text is written in; its organization stands in for `orgId`. */
    spaceId: z.string().uuid().nullish()
});

/** The organization a text belongs to. Only a claim: the guide is read for a
 *  member of it alone (`writing-profile.ts`), so naming another space or
 *  organization gets a rewrite without its guide, never the guide. */
async function textOrg(orgId?: string | null, spaceId?: string | null): Promise<string | null> {
    if (orgId) return orgId;
    if (!spaceId) return null;
    const space = await prisma.taskSpace.findUnique({ where: { id: spaceId }, select: { orgId: true } });
    return space?.orgId ?? null;
}

export async function POST(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    const limited = await rateLimit(`polar-improve:${user.id}`, 20, 60_000);
    if (!limited.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

    const access = await polarAccessFor(user.id);
    const { spaceId, ...input } = parsed.data;
    const orgId = await textOrg(input.orgId, spaceId).catch(() => null);
    const result = await improveText(user, access, { ...input, orgId });
    if ("refusal" in result) {
        const status = result.refusal === "failed" ? 502 : 409;
        return NextResponse.json({ error: result.refusal }, { status });
    }
    return NextResponse.json({ text: result.text }, { headers: { "Cache-Control": "no-store" } });
}
